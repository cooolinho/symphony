import fs from 'node:fs';
import { getTrackerFactory, supportedTrackerKinds } from '../tracker/registry.ts';
import { commandSkills, pluginAgents } from './command.ts';
import { normalizeStateName, type ServiceConfig } from './config.ts';
import { NEXT_STAGE, resultTargets, type RoleConfig } from './roles.ts';
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

/** Board columns referenced by the config (`tracker` states, `roles` including their result targets, `checks.on_enter`) that are not status options. */
export function unknownBoardColumns(config: ServiceConfig, statusOptions: readonly string[]): string[] {
  const known = new Set(statusOptions.map(normalizeStateName));
  const referenced = [
    ...config.tracker.activeStates,
    ...config.tracker.terminalStates,
    ...(config.roles ?? []).flatMap((role) => [
      ...role.states,
      ...(role.mayMoveTo ?? []),
      ...resultTargets(role),
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

/**
 * The active column after the last column `role` serves, in board order (the target of `on_result: next`); null when
 * the role's stage is the last one or the board does not list its columns. Active columns missing on the board are skipped.
 */
export function nextActiveColumn(role: Pick<RoleConfig, 'states'>, activeStates: readonly string[], boardColumns: readonly string[]): string | null {
  const order = new Map<string, number>();
  boardColumns.forEach((column, i) => {
    const key = normalizeStateName(column);
    if (!order.has(key)) order.set(key, i);
  });
  const own = new Set(role.states.map(normalizeStateName));
  const active = activeStates
    .filter((column) => order.has(normalizeStateName(column)))
    .sort((a, b) => (order.get(normalizeStateName(a)) ?? 0) - (order.get(normalizeStateName(b)) ?? 0));
  const last = active.findLastIndex((column) => own.has(normalizeStateName(column)));
  return last === -1 ? null : (active[last + 1] ?? null);
}

/**
 * Problems with `on_result: next` targets: the board order must be known (`boardColumns` null = the tracker does not
 * list columns) and the role must have a later active stage.
 */
export function nextStageProblems(config: ServiceConfig, boardColumns: readonly string[] | null): string[] {
  const problems: string[] = [];
  for (const role of config.roles ?? []) {
    for (const [verdict, target] of Object.entries(role.onResult)) {
      if (target !== NEXT_STAGE) continue;
      const path = `roles.${role.name}.on_result.${verdict}`;
      if (boardColumns === null || boardColumns.length === 0) {
        problems.push(`${path}: "${NEXT_STAGE}" needs the board's column order, which the tracker does not provide (name the column instead)`);
      } else if (nextActiveColumn(role, config.tracker.activeStates, boardColumns) === null) {
        problems.push(`${path}: "${NEXT_STAGE}" has no later active stage after ${role.states.join(', ')} on the board`);
      }
    }
  }
  return problems;
}
