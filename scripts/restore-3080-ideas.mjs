// Restore the real ideas ledger for the 3080 (web profile) DSH server.
//
// Background: the 30-card board existed only in 3080's memory. Test instance
// 3099 (ideas-test profile, SAME DSH home) held the ~/.dsh/ideas ledger lock
// and overwrote the file with its 2 smoke-test cards, so 3080 could never
// persist the real board. A raw restart would have made the board disappear.
//
// This script re-materialises the board from an API-state backup (defaults to
// backups/3080-ideas-state-*.json) and fixes the legacy 'ot' workspaceId to
// the real OpenTimbre workspace id in the target workspace registry.
//
// Usage:
//   node scripts/restore-3080-ideas.mjs [backupPath] [--apply]
//   IDEA_LEDGER_TARGET=... to override the ledger path.
//
// Without --apply the script only prints the plan. Idempotent: re-running with
// --apply restores again (a fresh .bak is kept each time).
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const backupPath = args.find((arg) => arg !== "--apply") ?? join(projectRoot, "backups", "3080-ideas-state-20260918-045149.json");
const target = process.env.IDEA_LEDGER_TARGET ?? "C:\\Users\\User\\.dsh\\ideas\\ledger-v2.json";

// OpenTimbre workspace id in ~/.dsh/storages/workspace.json (title "OpenTimbre").
const OT_WORKSPACE_ID = "c34460c8-476f-4dcd-abb2-f7376218d3e7";
const LEGACY_OT_SLUG = "ot";

if (!existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);

// Strip a UTF-8 BOM (PowerShell Out-File writes one) before parsing.
const raw = readFileSync(backupPath, "utf8").replace(/^\uFEFF/, "");
const state = JSON.parse(raw);
if (state.schemaVersion !== 1 || !Array.isArray(state.ideas)) {
  throw new Error("backup does not look like an ideas state snapshot (schemaVersion/ideas)");
}

let remapped = 0;
const ideas = state.ideas.map((idea) => {
  const next = { ...idea };
  if (next.workspaceId === LEGACY_OT_SLUG) {
    next.workspaceId = OT_WORKSPACE_ID;
    remapped += 1;
  }
  return next;
});

const document = {
  schemaVersion: 1,
  revision: Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
  ideas,
  importedSources: [],
  recentRequests: []
};

const byWs = {};
for (const idea of ideas) {
  const key = idea.workspaceId ?? "";
  byWs[key] = (byWs[key] ?? 0) + 1;
}

console.log("=== restore plan ===");
console.log(`backup        : ${backupPath}`);
console.log(`ideas         : ${ideas.length} (schemaVersion=${document.schemaVersion}, revision=${document.revision})`);
console.log(`remap ot->OT  : ${remapped}`);
console.log(`by workspace  : ${JSON.stringify(byWs)}`);
console.log(`target        : ${target}`);

if (!apply) {
  console.log("(dry run) pass --apply to write the ledger and clean the stale lock.");
  process.exit(0);
}

if (existsSync(target)) {
  const bak = `${target}.bak-3099-test-20260918`;
  if (!existsSync(bak)) copyFileSync(target, bak);
  console.log(`kept previous file at ${bak}`);
}

// Remove the stale lock dir left by the (now dead) 3099 pid, plus stray tmp files.
// The plugin names the lock `ledger-v2.lock` next to `ledger-v2.json` in the ideas dir.
const lockDir = join(dirname(target), "ledger-v2.lock");
if (existsSync(lockDir)) {
  rmSync(lockDir, { recursive: true, force: true });
  console.log(`removed stale lock dir: ${lockDir}`);
}
const dir = dirname(target);
const needle = `${basename(target)}.tmp-`;
for (const entry of readdirSync(dir)) {
  if (entry.startsWith(needle) && entry.length > needle.length) {
    rmSync(join(dir, entry), { force: true });
    console.log(`removed stray tmp: ${entry}`);
  }
}

// Match the plugin's writeAtomic format: JSON.stringify(doc, null, 2) + "\n".
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`written ${ideas.length} ideas -> ${target}`);
console.log("restore complete: restart the 3080 server to load the restored ledger.");