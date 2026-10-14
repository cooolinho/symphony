import fs from 'node:fs';
import { getTrackerFactory, supportedTrackerKinds } from '../tracker/registry.ts';
import { commandSkills, pluginAgents } from './command.ts';
import { normalizeStateName, type ServiceConfig } from './config.ts';
import type { EffectiveWorkflow, WorkflowLoadError } from './store.ts';

/**
 * Dispatch preflight (spec 6.3): can we poll the tracker and launch agents with this workflow?
 * Returns the problems found; an empty list means dispatch may proceed.
 */
export function validateDispatch(
  workflow: EffectiveWorkflow,
  loadError: WorkflowLoadError | null,
  env: NodeJS.ProcessEnv,
): string[] {
  const errors: string[] = [];
  if (loadError !== null) {
    errors.push(`WORKFLOW.md is invalid (${loadError.code}: ${loadError.message}); fix it to resume dispatching`);
  }

  const { tracker, claude } = workflow.config;
  if (tracker.kind === null) {
    errors.push('tracker.kind is required');
  } else {
    const factory = getTrackerFactory(tracker.kind);
    if (factory === undefined) {
      errors.push(`tracker.kind "${tracker.kind}" is not supported (supported: ${supportedTrackerKinds().join(', ')})`);
    } else {
      errors.push(...factory.validate(tracker.provider, env));
    }
  }
  if (tracker.activeStates.length === 0) errors.push('tracker.active_states is empty');

  if (claude.executable !== null) {
    try {
      fs.accessSync(claude.executable, fs.constants.X_OK);
    } catch {
      errors.push(`claude.executable ${claude.executable} does not exist or is not executable`);
    }
  }
  // A missing plugin directory would break every session start.
  for (const plugin of claude.plugins) {
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(plugin).isDirectory();
    } catch {
      // reported below
    }
    if (!isDirectory) errors.push(`claude.plugins entry ${plugin} is not a directory`);
  }
  // A command role without a skill would never get the instructions its issues ask for.
  const skills = commandSkills(claude.plugins);
  for (const role of workflow.config.roles ?? []) {
    for (const command of role.commands ?? []) {
      if (!skills.has(command)) errors.push(`roles.${role.name}.commands: no skill for /${command} in claude.plugins (expected skills/${command}/SKILL.md)`);
    }
  }
  // A role's subagent must exist, and a read-only role must not hand edits to a subagent.
  const agents = new Map(pluginAgents(claude.plugins).map((agent) => [agent.name, agent]));
  for (const role of workflow.config.roles ?? []) {
    for (const name of role.agents ?? []) {
      const agent = agents.get(name);
      if (agent === undefined) errors.push(`roles.${role.name}.agents: no subagent ${name} in claude.plugins (expected agents/${name}.md)`);
      else if (role.readOnly && !agent.readOnly) errors.push(`roles.${role.name}.agents: ${name} can edit files, but the role is read-only`);
    }
  }
  return errors;
}

/** Board columns referenced by the config (`tracker` states, `roles`, `checks.on_enter`) that are not status options. */
export function unknownBoardColumns(config: ServiceConfig, statusOptions: readonly string[]): string[] {
  const known = new Set(statusOptions.map(normalizeStateName));
  const referenced = [
    ...config.tracker.activeStates,
    ...config.tracker.terminalStates,
    ...(config.roles ?? []).flatMap((role) => [
      ...role.states,
      ...(role.mayMoveTo ?? []),
      ...(role.subIssueStatus !== null ? [role.subIssueStatus] : []),
    ]),
    ...config.checks.onEnter.keys(),
  ];
  const unknown = new Map<string, string>();
  for (const name of referenced) {
    const key = normalizeStateName(name);
    if (!known.has(key) && !unknown.has(key)) unknown.set(key, name);
  }
  return [...unknown.values()].map(
    (name) => `unknown board column "${name}" (valid: ${statusOptions.join(', ')})`,
  );
}
