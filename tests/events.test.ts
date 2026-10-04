/**
 * The activity-log model (part B): the bound, the shape guard, the
 * append rule, the actor vocabulary and the repair that migrates a document
 * written before the log existed.
 */

import { describe, expect, it } from 'vitest'
import {
  appendIdeaEvent,
  createIdea,
  IDEA_ACTOR_HUMAN,
  IDEA_ACTOR_RUN,
  IDEA_EVENT_ACTOR_MAX_LENGTH,
  IDEA_EVENT_LIMIT,
  IDEA_EVENT_SUMMARY_MAX_LENGTH,
  IDEA_EVENT_VERB_MAX_LENGTH,
  ideaEvent,
  ideaEventActor,
  isIdeaEvent,
  isIdeaRecordShape,
  normalizeIdeaEvents,
  type IdeaEvent,
} from '../src/core/ideas.ts'

const entry = (at: number, summary = 'moved'): IdeaEvent => ideaEvent(at, 'move', IDEA_ACTOR_HUMAN, summary)

describe('ideaEvent', () => {
  it('normalizes verb, actor and summary', () => {
    const value = ideaEvent(10, '  triage  ', '  you  ', '  value   3  effort 2  ')
    expect(value).toEqual({ at: 10, verb: 'triage', actor: 'you', summary: 'value 3 effort 2' })
  })

  it('falls back rather than storing a blank verb or actor', () => {
    expect(ideaEvent(1, '', '', 'did a thing').verb).toBe('update')
    expect(ideaEvent(1, '  ', '  ', 'did a thing').actor).toBe(IDEA_ACTOR_HUMAN)
  })

  it('bounds every field', () => {
    const value = ideaEvent(1, 'v'.repeat(100), 'a'.repeat(400), 's'.repeat(400))
    expect(value.verb).toHaveLength(IDEA_EVENT_VERB_MAX_LENGTH)
    expect(value.actor).toHaveLength(IDEA_EVENT_ACTOR_MAX_LENGTH)
    expect(value.summary).toHaveLength(IDEA_EVENT_SUMMARY_MAX_LENGTH)
  })
})

describe('ideaEventActor', () => {
  it('reads a browser write as the human and a tool or session write as an agent', () => {
    expect(ideaEventActor(undefined)).toBe(IDEA_ACTOR_HUMAN)
    expect(ideaEventActor('   ')).toBe(IDEA_ACTOR_HUMAN)
    expect(ideaEventActor('plugin:ideas-manager:ai-capture')).toBe('agent:plugin:ideas-manager:ai-capture')
  })

  it('lets the host name a transition that belongs to no caller', () => {
    expect(ideaEventActor('plugin:ideas-manager:ai-capture', IDEA_ACTOR_RUN)).toBe(IDEA_ACTOR_RUN)
    expect(ideaEventActor(undefined, IDEA_ACTOR_HUMAN)).toBe(IDEA_ACTOR_HUMAN)
  })

  it('bounds an over-long initiator instead of storing it whole', () => {
    expect(ideaEventActor('x'.repeat(400))).toHaveLength(IDEA_EVENT_ACTOR_MAX_LENGTH)
  })
})

describe('appendIdeaEvent', () => {
  it('keeps the last IDEA_EVENT_LIMIT entries and never mutates its input', () => {
    let events: IdeaEvent[] = []
    for (let at = 1; at <= IDEA_EVENT_LIMIT + 12; at += 1) {
      events = appendIdeaEvent(events, entry(at))
    }
    expect(events).toHaveLength(IDEA_EVENT_LIMIT)
    expect(events[0]?.at).toBe(13)
    expect(events[events.length - 1]?.at).toBe(IDEA_EVENT_LIMIT + 12)
    const frozen: IdeaEvent[] = [entry(1)]
    const appended = appendIdeaEvent(frozen, entry(2))
    expect(frozen).toHaveLength(1)
    expect(appended).toHaveLength(2)
  })

  it('starts a log from an absent one', () => {
    expect(appendIdeaEvent(undefined, entry(1))).toHaveLength(1)
  })
})

describe('isIdeaEvent', () => {
  it('accepts a well-formed entry', () => {
    expect(isIdeaEvent({ at: 1, verb: 'create', actor: 'human', summary: 'captured' })).toBe(true)
  })

  it('is strict on the four keys it owns', () => {
    expect(isIdeaEvent({ at: '1', verb: 'create', actor: 'human', summary: 'captured' })).toBe(false)
    expect(isIdeaEvent({ at: 1, verb: '', actor: 'human', summary: 'captured' })).toBe(false)
    expect(isIdeaEvent({ at: 1, verb: 'create', actor: '', summary: 'captured' })).toBe(false)
    expect(isIdeaEvent({ at: 1, verb: 'create', actor: 'human', summary: 7 })).toBe(false)
    expect(isIdeaEvent({ at: 1, verb: 'create', actor: 'human' })).toBe(false)
    expect(isIdeaEvent(null)).toBe(false)
    expect(isIdeaEvent([])).toBe(false)
  })

  it('keeps an entry a later version wrote with an extra field', () => {
    // A persisted log is repaired, not policed: losing readable history to a
    // key this version does not know about would be a silent data loss.
    expect(isIdeaEvent({ at: 1, verb: 'create', actor: 'human', summary: 'captured', v2: true })).toBe(true)
    expect(normalizeIdeaEvents([
      { at: 1, verb: 'create', actor: 'human', summary: 'captured', v2: true },
    ])).toEqual([{ at: 1, verb: 'create', actor: 'human', summary: 'captured' }])
  })
})

describe('normalizeIdeaEvents', () => {
  it('keeps a well-formed log untouched and answers undefined for an absent one', () => {
    const events = [entry(1), entry(2)]
    expect(normalizeIdeaEvents(events)).toEqual(events)
    expect(normalizeIdeaEvents(undefined)).toBeUndefined()
    expect(normalizeIdeaEvents(null)).toBeUndefined()
  })

  it('repairs a damaged log instead of losing the readable entries', () => {
    const repaired = normalizeIdeaEvents([
      entry(1),
      null,
      { at: 2, verb: 'x', summary: 'missing actor' },
      { at: 3, verb: 'decline', actor: 'human', summary: '   ' },
      { at: 4, verb: 'decline', actor: 'human', summary: 'declined twice' },
    ])
    expect(repaired?.map(event => event.summary)).toEqual(['moved', 'declined twice'])
  })

  it('re-applies the bound to a document that outgrew it', () => {
    const oversized = Array.from({ length: IDEA_EVENT_LIMIT + 30 }, (_unused, index) => entry(index))
    expect(normalizeIdeaEvents(oversized)).toHaveLength(IDEA_EVENT_LIMIT)
    expect(normalizeIdeaEvents(oversized)?.[0]?.at).toBe(30)
  })
})

describe('the record shape with an activity log', () => {
  const base = createIdea({ title: 'T', body: 'B', workspaceId: 'ws1' }, 1, 'a')

  it('accepts an idea with or without events', () => {
    expect(isIdeaRecordShape({ ...base, events: [entry(1)] })).toBe(true)
    expect(isIdeaRecordShape({ ...base })).toBe(true)
  })

  it('refuses a non-array events field', () => {
    expect(isIdeaRecordShape({ ...base, events: 'nope' })).toBe(false)
  })
})