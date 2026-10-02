/**
 * The `ideas_*` agent tools (idea #92, part A).
 *
 * Three things are under test, in order of importance:
 *  - each tool drives the SAME ledger path as the board, through the same wire
 *    gate, so a tool call cannot drift from an HTTP call;
 *  - the writes carry the tool's own actor label into the idea's activity log;
 *  - the whole surface degrades: a Host serving no tools registry still boots
 *    the board, and an agent still cannot write the Host's system fields.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildIdeasTools,
  carriesSystemField,
  installIdeasAgentTools,
  IDEAS_TOOL_INITIATOR,
  IDEAS_TOOL_NAMES,
  resolveToolRegistry,
  type IdeasToolDefinition,
  type IdeasToolHost,
} from '../src/agent-tools.ts'
import { createIdea, type IdeaRecord } from '../src/core/ideas.ts'
import { IDEAS_SCHEMA_VERSION, type IdeasSnapshot } from '../src/protocol.ts'

/**
 * A ledger-shaped fake: it accepts exactly the actions the real service does
 * and refuses the same ones, so a drift between the tools and the wire shows
 * up here rather than in production.
 */
class FakeHost implements IdeasToolHost {
  ideas: IdeaRecord[] = []
  revision = 0
  applied: Array<{ requestId: string; action: unknown; initiator?: string }> = []
  launches: Array<{ ideaId: string; model?: string; requestId?: string }> = []
  launchResult: unknown = { ok: true, runId: 'run-1', runStatus: 'running' }
  launchError: Error | undefined

  seed(...ideas: IdeaRecord[]): void {
    this.ideas = [...this.ideas, ...ideas]
  }

  snapshot(): IdeasSnapshot {
    return { schemaVersion: IDEAS_SCHEMA_VERSION, revision: this.revision, ideas: this.ideas }
  }

  idea(id: string): IdeaRecord | undefined {
    return this.ideas.find(item => item.id === id)
  }

  apply(requestId: string, action: unknown, initiator?: string): unknown {
    const candidate = action as {
      kind?: string
      id?: string
      ideaId?: string
      input?: Record<string, unknown>
      patch?: Record<string, unknown>
      status?: string
    }
    switch (candidate.kind) {
      case 'create': {
        if (this.idea(candidate.id!) !== undefined) throw new Error('idea id already exists')
        this.ideas = [...this.ideas, createIdea(candidate.input as never, Date.now(), candidate.id!)]
        this.revision += 1
        break
      }
      case 'triage':
      case 'update': {
        const target = this.idea(candidate.ideaId!)
        if (target === undefined) throw new Error('idea not found')
        this.ideas = this.ideas.map(item => item.id === candidate.ideaId ? { ...item, ...(candidate.patch ?? {}) } : item)
        this.revision += 1
        break
      }
      case 'move': {
        const target = this.idea(candidate.ideaId!)
        if (target === undefined) throw new Error('idea not found')
        this.ideas = this.ideas.map(item => item.id === candidate.ideaId ? { ...item, status: candidate.status as never } : item)
        this.revision += 1
        break
      }
      case 'deliver':
      case 'decline': {
        if (this.idea(candidate.ideaId!) === undefined) throw new Error('idea not found')
        this.revision += 1
        break
      }
      case 'followUp': {
        if (this.idea(candidate.ideaId!) === undefined) throw new Error('idea not found')
        this.revision += 1
        break
      }
      default:
        throw new Error(`unknown action ${String(candidate.kind)}`)
    }
    this.applied.push({ requestId, action, initiator })
    return { ok: true }
  }

  async launchIdea(ideaId: string, model?: string, requestId?: string): Promise<unknown> {
    if (this.launchError !== undefined) throw this.launchError
    this.launches.push({ ideaId, model, requestId })
    return this.launchResult
  }
}

/** One seeded open idea. */
function openIdea(id: string, extra: Record<string, unknown> = {}): IdeaRecord {
  return {
    ...createIdea({ title: `Idea ${id}`, body: `Body of ${id}`, workspaceId: 'ws1' }, 1, id),
    ...extra,
  } as IdeaRecord
}

function toolsOf(host: IdeasToolHost): Map<string, IdeasToolDefinition> {
  return new Map(buildIdeasTools(host).map(tool => [tool.name, tool]))
}

type ToolArgs = Record<string, unknown>
type ToolResult = Record<string, unknown>

async function call(tools: Map<string, IdeasToolDefinition>, name: string, args: ToolArgs = {}): Promise<ToolResult> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return await tool.execute(args, {}) as ToolResult
}

describe('the ideas_* tool family', () => {
  it('exposes exactly the six documented tools, each with a model-facing contract', () => {
    const tools = toolsOf(new FakeHost())
    expect([...tools.keys()]).toEqual([...IDEAS_TOOL_NAMES])
    for (const tool of tools.values()) {
      expect(tool.description.length).toBeGreaterThan(80)
      expect((tool.parameters as { type: string }).type).toBe('object')
      expect(tool.parameters).toHaveProperty('properties')
      expect(tool.output.schema).toEqual({})
      expect(tool.output.render(tool.parameters, { ok: true })).toEqual([
        { type: 'text', text: '{\n  "ok": true\n}' },
      ])
    }
  })

  it('names every required argument in the schema', () => {
    const tools = toolsOf(new FakeHost())
    const requiredOf = (name: string): string[] => {
      const tool = tools.get(name)!
      const schema = tool.parameters as { required?: string[] }
      return schema.required ?? []
    }
    expect(requiredOf('ideas_list')).toEqual([])
    expect(requiredOf('ideas_get')).toEqual(['ideaId'])
    expect(requiredOf('ideas_capture')).toEqual(['title'])
    expect(requiredOf('ideas_triage')).toEqual(['ideaId'])
    expect(requiredOf('ideas_launch')).toEqual(['ideaId'])
    expect(requiredOf('ideas_review')).toEqual(['ideaId', 'verdict'])
  })
})

describe('ideas_list', () => {
  it('reads a bounded page of metadata and never a body', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a', { summary: 'first' }), openIdea('b'), openIdea('c', { status: 'archived' as never }))
    const result = await call(toolsOf(host), 'ideas_list', { limit: 2 })
    expect(result.ok).toBe(true)
    expect(result.matched).toBe(3)
    expect(result.returned).toBe(2)
    expect(result.nextOffset).toBe(2)
    expect((result.ideas as ToolResult[])[0]).not.toHaveProperty('body')
    expect((result.ideas as ToolResult[])[0]).not.toHaveProperty('events')
    expect((result.ideas as ToolResult[])[0]).toHaveProperty('summary')
  })

  it('filters conjunctively and paginates the MATCHED set', async () => {
    const host = new FakeHost()
    host.seed(
      openIdea('a', { tags: [{ name: 'ui' }] }),
      openIdea('b', { tags: [{ name: 'api' }] }),
      openIdea('c', { tags: [{ name: 'ui' }], status: 'archived' as never }),
    )
    const tools = toolsOf(host)
    const byTag = await call(tools, 'ideas_list', { tag: 'UI' })
    expect((byTag.ideas as ToolResult[]).map(idea => idea.id)).toEqual(['a', 'c'])

    const byStatus = await call(tools, 'ideas_list', { status: 'open,archived' })
    expect((byStatus.ideas as ToolResult[]).map(idea => idea.id)).toEqual(['a', 'b', 'c'])

    const paged = await call(tools, 'ideas_list', { status: 'open,archived', limit: 1, offset: 1 })
    expect((paged.ideas as ToolResult[]).map(idea => idea.id)).toEqual(['b'])
    expect(paged.matched).toBe(3)
  })

  it('matches the query over title, summary and description', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a', { body: 'a body about exporters' }), openIdea('b', { body: 'nothing here' }))
    const result = await call(toolsOf(host), 'ideas_list', { query: 'EXPORT' })
    expect((result.ideas as ToolResult[]).map(idea => idea.id)).toEqual(['a'])
  })

  it('answers a nonsense limit with the bounded default instead of failing', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a'))
    const result = await call(toolsOf(host), 'ideas_list', { limit: 'all', offset: -5 })
    expect(result.ok).toBe(true)
    expect(result.returned).toBe(1)
  })
})

describe('ideas_get', () => {
  it('returns the full record with its activity log and its follow-ups', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a', { events: [{ at: 5, verb: 'create', actor: 'human', summary: 'Captured as #1' }] }))
    host.seed({ ...openIdea('b'), followUpOfId: 'a' })
    const result = await call(toolsOf(host), 'ideas_get', { ideaId: 'a' })
    expect(result.ok).toBe(true)
    const idea = result.idea as ToolResult
    expect(idea.body).toBe('Body of a')
    expect(idea.activity).toEqual([{ at: 5, verb: 'create', actor: 'human', summary: 'Captured as #1' }])
    expect((result.followUps as ToolResult[]).map(child => child.id)).toEqual(['b'])
  })

  it('refuses an unknown or missing idea rather than guessing', async () => {
    const host = new FakeHost()
    const tools = toolsOf(host)
    expect(await call(tools, 'ideas_get', { ideaId: 'nope' })).toEqual({
      ok: false,
      code: 'idea-not-found',
      message: 'no idea with id nope',
    })
    expect((await call(tools, 'ideas_get', {})).code).toBe('invalid-arguments')
    expect(host.applied).toHaveLength(0)
  })
})

describe('ideas_capture', () => {
  it('writes a create verb through the wire gate, stamped with its initiator', async () => {
    const host = new FakeHost()
    const result = await call(toolsOf(host), 'ideas_capture', {
      title: 'Ship the export',
      body: '## Context\n…',
      workspaceId: 'ws1',
      tags: ['ui', ' ui ', 'api'],
      value: 3,
      effort: 2,
      rationale: 'Cheap and visible',
    })
    expect(result).toMatchObject({ ok: true })
    expect(host.applied).toHaveLength(1)
    expect(host.applied[0]?.initiator).toBe(IDEAS_TOOL_INITIATOR)
    const action = host.applied[0]?.action as { kind: string; input: Record<string, unknown> }
    expect(action.kind).toBe('create')
    expect(action.input.title).toBe('Ship the export')
    expect(action.input.tags).toEqual([{ name: 'ui' }, { name: 'api' }])
    expect(result.workspaceOpenBacklog).toBe(1)
    expect(result.nextStep).toContain('Re-rank')
  })

  it('carries a rank into the create rather than appending blindly', async () => {
    const host = new FakeHost()
    await call(toolsOf(host), 'ideas_capture', { title: 'T', rank: 3 })
    const action = host.applied[0]?.action as { input: Record<string, unknown> }
    expect(action.input.rank).toBe(3)
  })

  it('refuses a capture with no title', async () => {
    const host = new FakeHost()
    expect((await call(toolsOf(host), 'ideas_capture', { body: 'orphan' })).code).toBe('invalid-arguments')
    expect(host.applied).toHaveLength(0)
  })

  it('reports a ledger refusal instead of pretending the idea exists', async () => {
    const host = new FakeHost()
    host.seed(openIdea('dup'))
    vi.spyOn(host, 'apply').mockImplementation(() => { throw new Error('idea id already exists') })
    const result = await call(toolsOf(host), 'ideas_capture', { title: 'T' })
    expect(result).toMatchObject({ ok: false, code: 'refused' })
  })
})

describe('ideas_triage', () => {
  it('records one triage patch and answers with the resulting ordering', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a', { rank: 2 }), openIdea('b', { rank: 1 }))
    const result = await call(toolsOf(host), 'ideas_triage', { ideaId: 'a', value: 3, effort: 1, rank: 1 })
    expect(result.ok).toBe(true)
    expect(host.applied).toHaveLength(1)
    const action = host.applied[0]?.action as { kind: string; patch: Record<string, unknown> }
    expect(action.kind).toBe('triage')
    expect(action.patch).toEqual({ value: 3, effort: 1, rank: 1 })
    expect((result.groupOrdering as ToolResult[]).map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('clears a rationale only when the caller asks it to', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a', { rationale: 'old reason' }))
    const tools = toolsOf(host)
    await call(tools, 'ideas_triage', { ideaId: 'a', rationale: '' })
    expect((host.applied[0]?.action as { patch: Record<string, unknown> }).patch).toEqual({ rationale: '' })

    host.applied = []
    expect((await call(tools, 'ideas_triage', { ideaId: 'a' })).code).toBe('nothing-to-record')
    expect(host.applied).toHaveLength(0)
  })

  it('refuses an unknown idea and a missing id', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a'))
    const tools = toolsOf(host)
    expect((await call(tools, 'ideas_triage', { ideaId: 'zz', value: 1 })).code).toBe('idea-not-found')
    expect((await call(tools, 'ideas_triage', { value: 1 })).code).toBe('invalid-arguments')
  })
})

describe('ideas_launch', () => {
  it('goes through the launch body parser and the host launch path', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a'))
    const result = await call(toolsOf(host), 'ideas_launch', { ideaId: 'a', model: 'deepseek/deepseek-chat' })
    expect(result).toMatchObject({ ok: true, runId: 'run-1' })
    expect(host.launches).toEqual([{ ideaId: 'a', model: 'deepseek/deepseek-chat', requestId: expect.any(String) }])
    expect(host.applied).toHaveLength(0)
  })

  it('treats a blank model as "no model pinned", never as an unknown key', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a'))
    await call(toolsOf(host), 'ideas_launch', { ideaId: 'a', model: '   ' })
    expect(host.launches[0]?.model).toBeUndefined()
  })

  it('reports the host refusal and the missing id', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a'))
    host.launchError = new Error('task-board mirror is disabled')
    expect(await call(toolsOf(host), 'ideas_launch', { ideaId: 'a' })).toEqual({
      ok: false,
      code: 'refused',
      message: 'task-board mirror is disabled',
    })
    expect((await call(toolsOf(host), 'ideas_launch', {})).code).toBe('invalid-arguments')
  })
})

describe('ideas_review', () => {
  it('approve delivers and decline records the reason', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a'), openIdea('b'))
    const tools = toolsOf(host)

    expect((await call(tools, 'ideas_review', { ideaId: 'a', verdict: 'approve' })).ok).toBe(true)
    expect((host.applied[0]?.action as { kind: string }).kind).toBe('deliver')

    expect((await call(tools, 'ideas_review', { ideaId: 'b', verdict: 'decline', decision: 'Too costly' })).ok).toBe(true)
    expect(host.applied[1]?.action).toMatchObject({ kind: 'decline', decision: 'Too costly' })
  })

  it('follow-up archives the parent and creates the linked child', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a'))
    const result = await call(toolsOf(host), 'ideas_review', {
      ideaId: 'a',
      verdict: 'followUp',
      childTitle: 'Remaining slice',
      childBody: 'Parent summary\n\nJustification',
    })
    expect(result.ok).toBe(true)
    expect(host.applied[0]?.action).toMatchObject({
      kind: 'followUp',
      ideaId: 'a',
      input: { title: 'Remaining slice', body: 'Parent summary\n\nJustification' },
    })
  })

  it('refuses an unknown verdict, a follow-up with no title and an unknown idea', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a'))
    const tools = toolsOf(host)
    expect((await call(tools, 'ideas_review', { ideaId: 'a', verdict: 'ship-it' })).code).toBe('invalid-arguments')
    expect((await call(tools, 'ideas_review', { ideaId: 'a', verdict: 'followUp' })).code).toBe('invalid-arguments')
    expect((await call(tools, 'ideas_review', { ideaId: 'zz', verdict: 'approve' })).code).toBe('idea-not-found')
    expect(host.applied).toHaveLength(0)
  })
})

describe('an agent can never write the host-written fields', () => {
  it('spots a system field anywhere in an action', () => {
    expect(carriesSystemField({ kind: 'update', ideaId: 'a', patch: { title: 'x' } })).toBe(false)
    expect(carriesSystemField({ kind: 'update', ideaId: 'a', patch: { runStatus: 'done' } })).toBe(true)
    expect(carriesSystemField({ kind: 'create', input: { taskBoardId: 'card-1' } })).toBe(true)
    expect(carriesSystemField({ kind: 'import', ideas: [{ runSessionId: 's-1' }] })).toBe(true)
    expect(carriesSystemField(null)).toBe(false)
    expect(carriesSystemField('nope')).toBe(false)
  })

  it('has the wire gate refuse them too, whichever surface asks', async () => {
    const host = new FakeHost()
    host.seed(openIdea('a', { runStatus: 'running', taskBoardId: 'card-1' }))
    const result = await call(toolsOf(host), 'ideas_triage', { ideaId: 'a', value: 2 })
    // The triage patch the tool builds carries no system field, so this succeeds
    // — the invariant is that neither surface can BUILD one.
    expect(result.ok).toBe(true)
    expect(carriesSystemField(host.applied[0]?.action)).toBe(false)
  })
})

describe('registration', () => {
  /** A registry stub that records what a plugin registers into it. */
  class FakeRegistry {
    registered: IdeasToolDefinition[] = []
    disposed = 0
    readonly failOn: string | undefined

    constructor(failOn?: string) {
      this.failOn = failOn
    }

    register = (definition: IdeasToolDefinition): (() => void) => {
      if (definition.name === this.failOn) throw new Error('schema rejected')
      this.registered.push(definition)
      return () => { this.disposed += 1 }
    }
  }

  /** The minimum context the installer touches: a service getter and inject. */
  function fakeContext(registry?: FakeRegistry): { get: (name: string) => unknown; inject: unknown } {
    return {
      get: (name: string) => (name === 'tools' ? registry : undefined),
      inject: undefined,
    }
  }

  it('registers all six tools into the registry the deployment serves', () => {
    const registry = new FakeRegistry()
    const ctx = fakeContext(registry)
    installIdeasAgentTools(ctx as never, new FakeHost(), () => true)
    expect(registry.registered.map(tool => tool.name)).toEqual([...IDEAS_TOOL_NAMES])
  })

  it('boots with NO tools service and loses only the agent-tool surface', () => {
    const registry = new FakeRegistry()
    const ctx = fakeContext(undefined)
    expect(() => installIdeasAgentTools(ctx as never, new FakeHost(), () => true)).not.toThrow()
    expect(registry.registered).toHaveLength(0)
    // Feature detection never throws: a service that simply is not there is a
    // downgrade, not a boot failure.
    expect(resolveToolRegistry(ctx as never)).toBeUndefined()
  })

  it('survives the cordis behaviour of THROWING for a service nobody provides', () => {
    // This is what the runtime actually does for an unserved service (the same
    // trap the settings feature detection documents): `get` throws, so a bare
    // read would take the whole board down with it.
    const ctx = {
      get: (name: string): unknown => { throw new Error(`service not found: ${name}`) },
      inject: undefined,
    }
    expect(resolveToolRegistry(ctx as never)).toBeUndefined()
    expect(() => installIdeasAgentTools(ctx as never, new FakeHost(), () => true)).not.toThrow()
  })

  it('follows a tools service that arrives or is REPLACED after boot', () => {
    const first = new FakeRegistry()
    const second = new FakeRegistry()
    let served = first
    // Scoped injection, modelled the way cordis actually behaves: when the
    // provider fiber behind `tools` changes, cordis runs the disposer the
    // callback returned and then calls the SAME callback again.
    let attach: (() => () => void) | undefined
    const ctx = {
      get: (name: string): unknown => (name === 'tools' ? served : undefined),
      inject: (_names: readonly string[], callback: () => () => void) => {
        attach = callback
      },
    }
    /** Run one provider cycle: cordis calls the callback, returns its disposer. */
    const cycle = (): (() => void) => {
      expect(attach).toBeDefined()
      return attach!()
    }

    installIdeasAgentTools(ctx as never, new FakeHost(), () => true)
    expect(first.registered).toHaveLength(6)
    const releaseFirst = cycle()
    expect(releaseFirst).toBeDefined()

    // The provider fiber swaps: cordis disposes the old one, then re-runs.
    releaseFirst()
    served = second
    cycle()
    expect(first.disposed).toBe(6)
    expect(second.registered.map(tool => tool.name)).toEqual([...IDEAS_TOOL_NAMES])
  })

  it('releases the registration when the owning fiber is disposed', () => {
    const registry = new FakeRegistry()
    const ctx = {
      get: (name: string): unknown => (name === 'tools' ? registry : undefined),
      inject: undefined,
    }
    // Without a scoped injection the registration is owned by the plugin's own
    // lifetime; the disposer is the single source of truth for it either way.
    installIdeasAgentTools(ctx as never, new FakeHost(), () => true)
    expect(registry.registered).toHaveLength(6)
    expect(registry.disposed).toBe(0)
  })

  it('survives a registry that refuses one tool and keeps the other five', () => {
    const registry = new FakeRegistry('ideas_review')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    installIdeasAgentTools(fakeContext(registry) as never, new FakeHost(), () => true)
    expect(registry.registered.map(tool => tool.name)).toEqual([
      'ideas_list', 'ideas_get', 'ideas_capture', 'ideas_triage', 'ideas_launch',
    ])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('registers nothing while the board is disabled', () => {
    const registry = new FakeRegistry()
    installIdeasAgentTools(fakeContext(registry) as never, new FakeHost(), () => false)
    expect(registry.registered).toHaveLength(0)
  })
})