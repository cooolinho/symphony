#!/usr/bin/env node
// Interactive setup for the repositories in GITHUB_REPOSITORY, e.g. the standard "Model: …" labels.
// Run with `npm run repo-init` or `./repo-init.ts`; see README, "Repositories einrichten (repo-init)".
import { runRepoInit } from './src/repo-init/main.ts';

runRepoInit({
  argv: process.argv.slice(2),
  env: process.env,
  rootDir: import.meta.dirname,
  input: process.stdin,
  output: process.stdout,
  errorOutput: process.stderr,
}).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`repo-init: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
