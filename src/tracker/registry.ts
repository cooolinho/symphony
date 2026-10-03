import type { TrackerDefaults } from '../workflow/config.ts';
import { githubProjectFactory } from './github-project/index.ts';
import type { TrackerAdapterFactory } from './types.ts';

const factories = new Map<string, TrackerAdapterFactory>([[githubProjectFactory.kind, githubProjectFactory]]);

export function getTrackerFactory(kind: string | null): TrackerAdapterFactory | undefined {
  return kind === null ? undefined : factories.get(kind);
}

export function supportedTrackerKinds(): string[] {
  return [...factories.keys()];
}

export function trackerDefaults(kind: string): TrackerDefaults | undefined {
  const factory = factories.get(kind);
  return factory && { activeStates: factory.defaultActiveStates, terminalStates: factory.defaultTerminalStates };
}
