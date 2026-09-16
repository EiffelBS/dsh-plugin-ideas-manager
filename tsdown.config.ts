/**
 * Standalone build config for the dsh-plugin-ideas-manager client plugin.
 *
 * Mirrors the dsh-web family discipline (packages/dsh-task-board): the node
 * half is bundled to lib/index.js (host process), the browser half is bundled
 * to lib/client.js as a closure-factory artifact for the GUI's
 * __ModuleLoader__ ({ id, factory } handoff; externals are resolved through
 * the loader's injected require). Types are emitted separately by
 * `tsc -p tsconfig.build.json` into lib/types (the build script runs tsc
 * first, then this config).
 *
 * React and every non-external dependency are inlined into the browser
 * bundle: the loader module table only answers platform modules and plugin
 * ids, never 'react'.
 */
import type { UserConfig } from 'tsdown'

/** Plugin id (package name) stamped into the __ModuleLoader__.load handoff. */
const ID = 'dsh-plugin-ideas-manager'

/** Node-half externals resolved from the running dsh host profile tree. */
const HOST_EXTERNALS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-system-prompt',
  'schemastery',
]

/** Node half: the Host plugin (routes + mock ledger + announcement). */
const nodeHalf: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Resolved from the running dsh host profile tree.
  deps: { neverBundle: [...HOST_EXTERNALS] },
}

/** Browser half: the GUI plugin (sidebar entry + kanban view). */
const clientHalf: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // Browser bundle lands next to the node half (single lib/ dir); the
  // entryFileNames pin keeps it exactly lib/client.js. clean stays off so the
  // node-half output above survives.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  // The loader module table answers platform modules and plugin ids. This
  // plugin's browser code only imports type-level @deepseek-ai/cordis (erased
  // before bundling), so nothing needs to stay external; everything else is
  // inlined (react, react-dom, ...). onlyBundle: false silences the
  // "unintended bundling" hint — inlining here is intentional.
  deps: { alwaysBundle: () => true, onlyBundle: false },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeHalf, clientHalf]
