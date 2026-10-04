import type { GithubRestClient } from './github-rest.ts';
import { labelsTask } from './labels.ts';
import { laravelBoostTask } from './laravel-boost.ts';
import type { Terminal } from './terminal.ts';

/** What a setup task works with: the repositories the user picked, a GitHub client and the terminal. */
export interface InitContext {
  repositories: string[];
  github: GithubRestClient;
  terminal: Terminal;
}

/** One entry of the repo-init menu. */
export interface InitTask {
  id: string;
  title: string;
  /** Shown next to the title in the menu. */
  summary: string;
  /** Runs the task interactively; resolves to false if something failed. */
  run(context: InitContext): Promise<boolean>;
}

/** The repo-init menu in display order. New setup steps are added here. */
export const INIT_TASKS: readonly InitTask[] = [labelsTask, laravelBoostTask];
