#!/usr/bin/env node
/**
 * Run the Tauri CLI with repo-root .env loaded (Windows signing needs AZURE_*).
 * Usage: node scripts/run-tauri.js build --target x86_64-pc-windows-msvc ...
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { loadDotenv } = require('./load-dotenv');
const { getBuildEnvironment } = require('./build-env');

const repoRoot = path.join(__dirname, '..');
const { count, path: envPath, missing } = loadDotenv(repoRoot);

if (missing) {
  console.warn(`[run-tauri] No .env at ${envPath} — Azure signing will be skipped unless vars are in the shell environment.`);
} else if (count === 0) {
  console.warn(`[run-tauri] .env exists but no variables loaded from ${envPath}`);
} else {
  console.log(`[run-tauri] Loaded ${count} variable(s) from .env`);
}

// Run the CLI's own entry script with this Node, not through `npx` and a
// shell. A shell re-parses the joined arguments, so inline JSON such as
// `--config '{"bundle":{...}}'` lost its quotes and Windows paths with spaces
// split in two. Without a shell there is no need for `npx.cmd` on Windows.
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js', { paths: [repoRoot] });

const result = spawnSync(process.execPath, [tauriCli, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: getBuildEnvironment(process.env),
  stdio: 'inherit',
});

process.exit(result.status === null ? 1 : result.status);
