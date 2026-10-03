import { TrackerError, type TrackerAdapterFactory } from '../types.ts';
import { GithubProjectAdapter } from './adapter.ts';
import { GithubGraphqlClient } from './client.ts';
import { KIND, parseSettings, secretEnvironmentNames } from './settings.ts';

export const githubProjectFactory: TrackerAdapterFactory = {
  kind: KIND,
  defaultActiveStates: ['Todo', 'In Progress'],
  defaultTerminalStates: ['Done'],

  validate(provider, env) {
    return parseSettings(provider, env).errors;
  },

  secretEnvironmentNames(provider) {
    return secretEnvironmentNames(provider);
  },

  create({ provider, env, logger, fetch }) {
    const { settings, errors, category } = parseSettings(provider, env);
    if (settings === null) throw new TrackerError(category, errors.join('; '));
    if (settings.tokenSource === 'literal') {
      logger.warn('tracker.provider.token is a literal value; prefer $GITHUB_TOKEN so the agent cannot read it from WORKFLOW.md');
    }
    const client = new GithubGraphqlClient({
      endpoint: settings.endpoint,
      token: settings.token,
      timeoutMs: settings.requestTimeoutMs,
      retries: settings.requestRetries,
      fetch,
    });
    return new GithubProjectAdapter(settings, client, logger);
  },
};
