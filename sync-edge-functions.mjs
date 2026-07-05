// scripts/sync-edge-functions.mjs
//
// WHY THIS EXISTS: Supabase's Edge Function bundler is unreliable about
// importing files from outside `supabase/functions/`, especially across
// platforms (see supabase/cli#2862, supabase/cli#1338 — Windows in
// particular breaks on relative imports that escape the functions tree).
// Their own docs recommend keeping all shared code inside
// `supabase/functions/_shared/` and importing it with a plain relative
// path. Rather than fight the bundler, this script makes `_shared/` a
// generated mirror of the real source of truth (`src/engine/` and `data/`),
// run right before every deploy.
//
// Run this via: `npm run sync:edge` (add that script to package.json),
// and again as a `predeploy` step before `supabase functions deploy`.
// `supabase/functions/_shared/engine` and `_shared/data` are generated —
// do not hand-edit them, and .gitignore them if you want to keep the repo
// diff-clean (regenerating is cheap and deterministic).

import { cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const copies = [
  { from: path.join(repoRoot, "src", "engine"), to: path.join(repoRoot, "supabase", "functions", "_shared", "engine") },
  { from: path.join(repoRoot, "data"), to: path.join(repoRoot, "supabase", "functions", "_shared", "data") },
];

for (const { from, to } of copies) {
  if (!existsSync(from)) {
    console.error(`sync-edge-functions: source not found: ${from}`);
    process.exitCode = 1;
    continue;
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`synced ${path.relative(repoRoot, from)} -> ${path.relative(repoRoot, to)}`);
}
