import { normalizeStateName } from '../../workflow/config.ts';
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

  create({ provider, activeStates, terminalStates, env, logger, fetch }) {
    const { settings, errors, category } = parseSettings(provider, env);
    if (settings === null) throw new TrackerError(category, errors.join('; '));
    // An agent-created sub-issue in an active column would be dispatched without a human looking at it first.
    const subIssueStatus = normalizeStateName(settings.subIssueStatus);
    if ([...activeStates, ...terminalStates].some((state) => normalizeStateName(state) === subIssueStatus)) {
      throw new TrackerError(
        'invalid_tracker_config',
        `tracker.provider.sub_issue_status "${settings.subIssueStatus}" must not be an active or terminal state`,
      );
    }
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
