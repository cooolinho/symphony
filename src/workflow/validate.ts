import fs from 'node:fs';
import { getTrackerFactory, supportedTrackerKinds } from '../tracker/registry.ts';
import { commandSkills, pluginAgents } from './command.ts';
import { normalizeStateName, type ServiceConfig } from './config.ts';
import { NEXT_STAGE, resultTargets, roleFor, roleName, type RoleConfig } from './roles.ts';
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

/** Board columns referenced by the config (`tracker` states, `roles` including their result targets, the targets of `pipeline.profiles`, `checks.on_enter`) that are not status options. */
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
    ...[...config.pipeline.profiles.values()].flatMap((profile) => Object.values(profile.onResult).flatMap((targets) => Object.values(targets))).filter((target) => target !== NEXT_STAGE),
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
 * The active columns after the last column `role` serves, in board order (the candidates of `on_result: next`); null
 * when the board does not list the role's columns. Active columns missing on the board are skipped.
 */
export function laterActiveColumns(role: Pick<RoleConfig, 'states'>, activeStates: readonly string[], boardColumns: readonly string[]): string[] | null {
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
  return last === -1 ? null : active.slice(last + 1);
}

/**
 * The active column after the last column `role` serves, in board order (the target of `on_result: next`); null when
 * the role's stage is the last one or the board does not list its columns. Active columns missing on the board are skipped.
 */
export function nextActiveColumn(role: Pick<RoleConfig, 'states'>, activeStates: readonly string[], boardColumns: readonly string[]): string | null {
  return laterActiveColumns(role, activeStates, boardColumns)?.[0] ?? null;
}

/** Whether `role` may move an issue to `column`: never a terminal column, and one of `may_move_to` when it is set. */
export function canMoveTo(role: Pick<RoleConfig, 'mayMoveTo'>, column: string, terminalStates: readonly string[]): boolean {
  const key = normalizeStateName(column);
  if (terminalStates.some((state) => normalizeStateName(state) === key)) return false;
  return role.mayMoveTo === null || role.mayMoveTo.some((allowed) => normalizeStateName(allowed) === key);
}

/** The problem with `on_result: next` when the tracker lists no columns (also the resolver's runtime message). */
export function nextWithoutBoardOrder(path: string): string {
  return `${path}: "${NEXT_STAGE}" needs the board's column order, which the tracker does not provide (name the column instead)`;
}

/** The roles that serve the security review (`result: security`) for issues without a command: the conditional stage after the review. */
export function securityRoles(roles: readonly RoleConfig[] | null): RoleConfig[] {
  return (roles ?? []).filter((role) => role.result === 'security' && role.commands === null);
}

/** The roles that serve the documentation stage (`result: docs`) for issues without a command: the conditional stage before the review. */
export function docsRoles(roles: readonly RoleConfig[] | null): RoleConfig[] {
  return (roles ?? []).filter((role) => role.result === 'docs' && role.commands === null);
}

/**
 * Problems with the route to the security review: a reviewer (`result: review`) whose `approved` leads out of the active
 * columns goes to the security review's column when the issue needs it, so a reviewer with `may_move_to` must list that
 * column, and the board must list it (`boardColumns` null = unknown, not checked).
 */
export function securityReviewProblems(config: ServiceConfig): string[] {
  const problems: string[] = [];
  const active = new Set(config.tracker.activeStates.map(normalizeStateName));
  for (const auditor of securityRoles(config.roles)) {
    const column = config.tracker.activeStates.find((state) => auditor.states.includes(normalizeStateName(state)));
    if (column === undefined) {
      problems.push(`roles.${auditor.name}: the security review serves no column of tracker.active_states, so no issue is ever routed to it`);
      continue;
    }
    for (const reviewer of (config.roles ?? []).filter((role) => role.result === 'review')) {
      const approved = reviewer.onResult.approved;
      if (approved === undefined || approved === NEXT_STAGE || active.has(normalizeStateName(approved))) continue;
      if (!canMoveTo(reviewer, column, config.tracker.terminalStates)) {
        problems.push(`roles.${reviewer.name}.may_move_to must list "${column}": an approved issue goes there when it needs a security review (roles.${auditor.name})`);
      }
    }
  }
  return problems;
}

/**
 * Problems with the route to the documentation stage: a developer or test engineer whose `done` / `passed` leads to the
 * reviewer goes to the docs column when the issue needs it, so such a role with `may_move_to` must list that column.
 */
export function docsStageProblems(config: ServiceConfig): string[] {
  const problems: string[] = [];
  const active = new Set(config.tracker.activeStates.map(normalizeStateName));
  for (const writer of docsRoles(config.roles)) {
    const column = config.tracker.activeStates.find((state) => writer.states.includes(normalizeStateName(state)));
    if (column === undefined) {
      problems.push(`roles.${writer.name}: the documentation stage serves no column of tracker.active_states, so no issue is ever routed to it`);
      continue;
    }
    for (const role of config.roles ?? []) {
      const verdict = role.result === 'implementation' ? 'done' : role.result === 'test' ? 'passed' : null;
      const target = verdict === null ? undefined : role.onResult[verdict];
      if (target === undefined || target === NEXT_STAGE || !active.has(normalizeStateName(target))) continue;
      const reviews = (config.roles ?? []).some((candidate) => candidate.result === 'review' && candidate.states.includes(normalizeStateName(target)));
      if (reviews && !canMoveTo(role, column, config.tracker.terminalStates)) {
        problems.push(`roles.${role.name}.may_move_to must list "${column}": an issue goes there when it needs documentation (roles.${writer.name})`);
      }
    }
  }
  return problems;
}

/**
 * Problems with `on_result: next` targets, for the roles' own transitions and again for each profile of
 * `pipeline.profiles` (whose `skip` passes over later stages and whose `on_result` overrides the role's): the board order
 * must be known (`boardColumns` null = the tracker does not list columns), the role must have a later active stage the
 * profile does not skip, and a role with `may_move_to` must list that stage's column (the transition guard enforces
 * `may_move_to` for computed targets too). A stage in the profile's `skip_when` may or may not be skipped, so `next`
 * can lead to it or past it: every column it can lead to is checked.
 */
export function nextStageProblems(config: ServiceConfig, boardColumns: readonly string[] | null): string[] {
  const problems: string[] = [...securityReviewProblems(config), ...docsStageProblems(config)];
  const profiles = [null, ...config.pipeline.profiles.values()];
  for (const profile of profiles) {
    const suffix = profile === null ? '' : ` (profile ${profile.name})`;
    for (const role of config.roles ?? []) {
      const override: Readonly<Record<string, string>> = (profile !== null && profile.onResult[role.name]) || {};
      for (const [verdict, target] of Object.entries({ ...role.onResult, ...override })) {
        if (target !== NEXT_STAGE) continue;
        const path = Object.hasOwn(override, verdict) ? `pipeline.profiles.${profile?.name}.on_result.${role.name}.${verdict}` : `roles.${role.name}.on_result.${verdict}`;
        const later = boardColumns === null || boardColumns.length === 0 ? undefined : laterActiveColumns(role, config.tracker.activeStates, boardColumns);
        if (later === undefined) {
          problems.push(`${nextWithoutBoardOrder(path)}${suffix}`);
          continue;
        }
        const skipped = new Set(profile?.skip ?? []);
        const reachable: string[] = [];
        for (const column of later ?? []) {
          const name = roleName(roleFor({ state: column, description: null }, config.roles));
          if (skipped.has(name)) continue;
          reachable.push(column);
          if (profile === null || !Object.hasOwn(profile.skipWhen, name)) break;
        }
        if (reachable.length === 0) {
          problems.push(`${path}: "${NEXT_STAGE}" has no later active stage after ${role.states.join(', ')} on the board${suffix}`);
        }
        for (const next of reachable) {
          if (!canMoveTo(role, next, config.tracker.terminalStates)) {
            problems.push(`${path}: "${NEXT_STAGE}" leads to "${next}", which is not in roles.${role.name}.may_move_to (add it there)${suffix}`);
          }
        }
      }
    }
  }
  return problems;
}
