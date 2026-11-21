import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GithubGraphqlClient } from '../tracker/github-project/client.ts';
import { DEFAULT_ENDPOINT, DEFAULT_STATUS_FIELD, TOKEN_FALLBACK_ENV, isRepositoryName, parseProjectReference, splitRepositoryList } from '../tracker/github-project/settings.ts';
import { loadEnvFile, type LoadedEnvFile } from '../util/env.ts';
import { errorMessage } from '../util/errors.ts';
import { GithubRestClient } from './github-rest.ts';
import type { BoardContext } from './board.ts';
import { INIT_TASKS, type InitTask } from './tasks.ts';
import { Terminal } from './terminal.ts';

export const USAGE = `Usage: repo-init [options]

Interactive setup for the repositories in GITHUB_REPOSITORY (owner/name, comma-separated;
from the shell or the env file). Pick what to set up from a list: the standard "Model: …"
labels that choose the Claude model per issue, an issue that adds Laravel Boost to
Laravel apps without it, or the missing columns of the board in GITHUB_PROJECT_NUMBER.

Options:
  --all               Run all setup tasks without the selection menu.
  --task <id>         Run only this task without the menu (labels, laravel-boost, board);
                      repeat it for several tasks.
  --yes, -y           Confirm all prompts with the default answer (use with --all for
                      fully non-interactive mode, e.g. in CI).
  --env-file <path>   Load variables from this dotenv file (default: .env next to
                      repo-init.ts, if present). Variables already set in the shell win.
  -h, --help          Show this help.

Needs GITHUB_TOKEN (or GH_TOKEN): a classic token with the "repo" scope, or a fine-grained
token with "Issues: Read and write" and "Contents: Read" on the repositories. The board
task also needs the "project" scope (classic token) and GITHUB_PROJECT_NUMBER (number or
URL); GITHUB_PROJECT_OWNER names the board owner if it is not the repository owner.
`;

export interface RepoInitOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Directory of repo-init.ts; the .env there is loaded unless --env-file names another file. */
  rootDir: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Where errors go; defaults to `output`. */
  errorOutput?: NodeJS.WritableStream;
  fetch?: typeof fetch;
}

export interface ParsedFlags {
  all: boolean;
  yes: boolean;
  envFile?: string;
  help: boolean;
}

/** Runs the interactive repository setup and returns the process exit code. */
export async function runRepoInit(options: RepoInitOptions): Promise<number> {
  const fail = (message: string, code = 1): number => {
    (options.errorOutput ?? options.output).write(`repo-init: ${message}\n`);
    return code;
  };

  let values: { 'env-file'?: string; help?: boolean; all?: boolean; yes?: boolean; task?: string[] };
  try {
    ({ values } = parseArgs({
      args: options.argv,
      options: {
        'env-file': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        all: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        task: { type: 'string', multiple: true },
      },
    }));
  } catch (error) {
    return fail(`${errorMessage(error)}\n\n${USAGE}`, 2);
  }
  if (values.help === true) {
    options.output.write(USAGE);
    return 0;
  }
  const taskIds = values.task ?? [];
  const unknownTasks = taskIds.filter((id) => !INIT_TASKS.some((task) => task.id === id));
  if (unknownTasks.length > 0) return fail(`unknown task ${unknownTasks.join(', ')} (valid: ${INIT_TASKS.map((task) => task.id).join(', ')})\n\n${USAGE}`, 2);
  const runAll = values.all === true;
  const autoYes = values.yes === true;

  // Same rules as symphony itself: the env file fills in what the shell does not set.
  let envFile: LoadedEnvFile | null = null;
  const envFilePath = values['env-file'] !== undefined ? path.resolve(values['env-file']) : path.join(options.rootDir, '.env');
  if (values['env-file'] !== undefined || fs.existsSync(envFilePath)) {
    try {
      envFile = loadEnvFile(envFilePath, options.env);
    } catch (error) {
      return fail(errorMessage(error));
    }
  }
  const env = envFile?.env ?? options.env;

  const names = splitRepositoryList(env.GITHUB_REPOSITORY ?? '');
  if (names.length === 0) return fail('GITHUB_REPOSITORY is not set: put owner/name in .env (comma-separate several repositories)');
  const invalid = names.filter((name) => !isRepositoryName(name));
  if (invalid.length > 0) return fail(`GITHUB_REPOSITORY needs owner/name entries (got ${invalid.map((name) => JSON.stringify(name)).join(', ')})`);
  const repositories = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
  const tokenName = TOKEN_FALLBACK_ENV.find((name) => (env[name] ?? '') !== '');
  if (tokenName === undefined) return fail(`no GitHub token: set ${TOKEN_FALLBACK_ENV.join(' or ')} (classic token with the "repo" scope)`);
  const token = env[tokenName] as string;

  let board: BoardContext | undefined;
  const projectText = env.GITHUB_PROJECT_NUMBER ?? '';
  if (projectText.trim() !== '') {
    const project = parseProjectReference(projectText);
    if (project === null) return fail(`GITHUB_PROJECT_NUMBER must be a project number or project URL (got ${JSON.stringify(projectText)})`);
    const owner = (env.GITHUB_PROJECT_OWNER ?? '').trim() || project.owner || (repositories[0]?.split('/')[0] ?? '');
    board = {
      owner,
      number: project.number,
      statusField: DEFAULT_STATUS_FIELD,
      graphql: new GithubGraphqlClient({ endpoint: DEFAULT_ENDPOINT, token, timeoutMs: 30_000, fetch: options.fetch }),
    };
  }

  const terminal = new Terminal(options.input, options.output, { yes: autoYes });
  try {
    terminal.print('Symphony repo-init');
    terminal.print(`Env file:  ${envFile?.file ?? '(none)'}`);
    const shadowed = envFile?.shadowed.filter((name) => name === 'GITHUB_REPOSITORY' || name === tokenName) ?? [];
    if (shadowed.length > 0) terminal.print(`           the shell overrides ${shadowed.join(', ')} from this file`);
    terminal.print(`Token:     ${tokenName}`);

    let selected = repositories;
    if (repositories.length > 1) {
      terminal.print('Repositories (GITHUB_REPOSITORY):');
      const picked = await terminal.chooseMany('Which repositories?', repositories.map((name) => ({ label: name, value: name })));
      if (picked === null) return 0;
      selected = picked;
    } else {
      terminal.print(`Repository: ${repositories[0] ?? ''}`);
    }

    const github = new GithubRestClient({ token, fetch: options.fetch });
    let ok = true;
    if (runAll || taskIds.length > 0) {
      const tasks: InitTask[] = runAll ? [...INIT_TASKS] : INIT_TASKS.filter((task) => taskIds.includes(task.id));
      for (const task of tasks) {
        terminal.print();
        terminal.print(`── ${task.title} ──`);
        if (!(await task.run({ repositories: selected, github, terminal, board }))) ok = false;
      }
    } else {
      for (;;) {
        terminal.print();
        terminal.print('What do you want to set up?');
        const task = await terminal.choose('Choice', INIT_TASKS.map((entry) => ({ label: `${entry.title}: ${entry.summary}`, value: entry })));
        if (task === null) break;
        terminal.print();
        if (!(await task.run({ repositories: selected, github, terminal, board }))) ok = false;
      }
    }
    return ok ? 0 : 1;
  } finally {
    terminal.close();
  }
}
