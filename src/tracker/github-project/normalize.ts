import { parseIssueCommand } from '../../workflow/command.ts';
import type { BlockerRef, Issue } from '../types.ts';
import type { GithubProjectSettings } from './settings.ts';
import { KIND } from './settings.ts';

/** Reported as `state` for board items that have no value in the status field. */
export const NO_STATUS = 'No Status';

export interface SelectOption {
  id: string;
  name: string;
}

export interface ProjectMeta {
  projectId: string;
  title: string;
  url: string | null;
  statusFieldId: string;
  statusOptions: SelectOption[];
  priority: { kind: 'single_select'; options: SelectOption[] } | { kind: 'number' } | null;
}

/** An issue (or pull request) referenced by repository and number. */
export interface IssueReference {
  repository: string;
  number: number;
}

/** Linked issue as exposed in `native_ref.parent` / `native_ref.sub_issues`. */
export interface LinkedIssue {
  identifier: string;
  title: string;
  state: string | null;
  /** Why a closed sub-issue was closed (COMPLETED, NOT_PLANNED, DUPLICATE); only present when GitHub reports one. */
  state_reason?: string;
}

/** Dispatch conditions known from the item itself; blockers are added once they are resolved. */
export interface DispatchGates {
  open: boolean;
  assigned: boolean;
}

export type NormalizeOutcome =
  | { kind: 'issue'; issue: Issue; textBlockers: IssueReference[]; gates: DispatchGates }
  | { kind: 'invisible'; reason: string }
  | { kind: 'malformed'; reason: string };

/** Blocker states that no longer block: closed issues, closed or merged pull requests. */
export const RESOLVED_STATES = new Set(['CLOSED', 'MERGED']);

const REFERENCE = '(?:[A-Za-z0-9-]+\\/[A-Za-z0-9._-]+)?#\\d+';
const TEXT_BLOCKER = new RegExp(
  `\\bblocked(?:\\s+by)?[*_]{0,2}\\s*:?\\s*[*_]{0,2}\\s*(${REFERENCE}(?:\\s*(?:,|&|\\band\\b|\\bund\\b)?\\s*${REFERENCE})*)`,
  'gi',
);
const REFERENCE_PARTS = /(?:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+))?#(\d+)/g;

/**
 * Dependencies written in the issue text: "blocked by #12", "Blocked #12", "blocked by: #3, #4 and owner/repo#5".
 * `#N` refers to the issue's own repository. Self-references and duplicates are dropped.
 */
export function parseTextBlockers(body: string | null, ownRepository: string, ownNumber: number): IssueReference[] {
  if (body === null) return [];
  const seen = new Map<string, IssueReference>();
  for (const match of body.matchAll(TEXT_BLOCKER)) {
    for (const part of (match[1] ?? '').matchAll(REFERENCE_PARTS)) {
      const repository = part[1] ?? ownRepository;
      const number = Number(part[2]);
      if (repository.toLowerCase() === ownRepository.toLowerCase() && number === ownNumber) continue;
      seen.set(`${repository.toLowerCase()}#${number}`, { repository, number });
    }
  }
  return [...seen.values()];
}

/**
 * Sets `dispatchable` and `native_ref.dispatch_note` from the gates, all known blockers
 * (`respect_blockers`) and open sub-issues (`respect_sub_issues`).
 */
export function applyDispatchRules(
  issue: Issue,
  gates: DispatchGates,
  settings: Pick<GithubProjectSettings, 'assignee' | 'respectBlockers' | 'respectSubIssues'>,
): void {
  const reasons: string[] = [];
  if (!gates.open) reasons.push('issue is closed');
  if (!gates.assigned) reasons.push(`not assigned to ${settings.assignee}`);
  if (settings.respectBlockers) {
    const open = issue.blocked_by.filter((blocker) => !RESOLVED_STATES.has(blocker.state ?? ''));
    if (open.length > 0) reasons.push(`blocked by ${open.map((b) => b.identifier ?? b.id ?? 'an unknown issue').join(', ')}`);
  }
  // An issue that starts with a `/command` produces its sub-issues (the audit's findings) instead of waiting for them.
  if (settings.respectSubIssues && parseIssueCommand(issue.description) === null) {
    const subIssues = (issue.native_ref?.sub_issues ?? []) as LinkedIssue[];
    const open = subIssues.filter((sub) => sub.state !== 'CLOSED');
    if (open.length > 0) reasons.push(`waiting for sub-issues ${open.map((sub) => sub.identifier).join(', ')}`);
  }
  issue.dispatchable = reasons.length === 0;
  if (issue.native_ref !== null) issue.native_ref.dispatch_note = reasons.length > 0 ? reasons.join('; ') : null;
}

function linkedIssue(node: Json | null): LinkedIssue | null {
  if (node === null) return null;
  const repo = str(obj(node.repository)?.nameWithOwner);
  if (repo === null || typeof node.number !== 'number') return null;
  const reason = str(node.stateReason);
  return {
    identifier: `${repo}#${node.number}`,
    title: typeof node.title === 'string' ? node.title : '',
    state: str(node.state),
    ...(reason !== null ? { state_reason: reason } : {}),
  };
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function nodes(connection: unknown): Json[] {
  const list = obj(connection)?.nodes;
  return Array.isArray(list) ? (list.map(obj).filter((n) => n !== null) as Json[]) : [];
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeLabels(names: unknown[]): string[] {
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const label = name.trim().toLowerCase();
    if (label !== '') seen.add(label);
  }
  return [...seen];
}

export function inRepositoryScope(settings: Pick<GithubProjectSettings, 'repositories'>, nameWithOwner: string | null): boolean {
  if (nameWithOwner === null) return false;
  return settings.repositories === null || settings.repositories.has(nameWithOwner.toLowerCase());
}

/**
 * Maps one `nodes(ids:)` / item-details entry to an Issue.
 * - invisible: deleted, archived, on another board, inaccessible (redacted), a draft or PR, or out of repository scope
 * - malformed: an issue whose required fields are missing
 */
export function normalizeItemNode(
  node: unknown,
  meta: ProjectMeta,
  settings: Pick<GithubProjectSettings, 'repositories' | 'assignee' | 'respectBlockers' | 'respectSubIssues' | 'baseBranch'>,
): NormalizeOutcome {
  const item = obj(node);
  if (item === null) return { kind: 'invisible', reason: 'not found' };
  if (item.__typename !== undefined && item.__typename !== 'ProjectV2Item') return { kind: 'invisible', reason: 'not a project item' };
  if (obj(item.project)?.id !== meta.projectId) return { kind: 'invisible', reason: 'item belongs to another project' };
  if (item.isArchived === true) return { kind: 'invisible', reason: 'archived' };

  const content = obj(item.content);
  if (content === null) return { kind: 'invisible', reason: 'content not accessible with this token' };
  if (content.__typename !== 'Issue') return { kind: 'invisible', reason: `content is a ${String(content.__typename)}` };

  const repository = str(obj(content.repository)?.nameWithOwner);
  if (!inRepositoryScope(settings, repository)) return { kind: 'invisible', reason: 'repository out of scope' };

  const itemId = str(item.id);
  const issueNodeId = str(content.id);
  const number = typeof content.number === 'number' ? content.number : null;
  const title = typeof content.title === 'string' ? content.title.trim() : '';
  if (itemId === null || issueNodeId === null || number === null || title === '' || repository === null) {
    return { kind: 'malformed', reason: 'issue is missing id, number, title or repository' };
  }

  const status = obj(item.status);
  const state = str(status?.name)?.trim() || NO_STATUS;

  const assignees = nodes(content.assignees)
    .map((a) => str(a.login))
    .filter((login): login is string => login !== null);
  const blockers: BlockerRef[] = nodes(content.blockedBy).map((b) => {
    const repo = str(obj(b.repository)?.nameWithOwner);
    const blockerNumber = typeof b.number === 'number' ? b.number : null;
    return {
      id: str(b.id),
      identifier: repo !== null && blockerNumber !== null ? `${repo}#${blockerNumber}` : null,
      state: str(b.state),
    };
  });

  const gates: DispatchGates = {
    open: content.state === 'OPEN',
    assigned: settings.assignee === null || assignees.some((login) => login.toLowerCase() === settings.assignee?.toLowerCase()),
  };
  const description = typeof content.body === 'string' && content.body.trim() !== '' ? content.body : null;
  const subIssues = nodes(content.subIssues)
    .map(linkedIssue)
    .filter((sub): sub is LinkedIssue => sub !== null);

  const issue: Issue = {
      id: itemId,
      native_ref: {
        provider: KIND,
        project_id: meta.projectId,
        item_id: itemId,
        issue_id: issueNodeId,
        repository,
        number,
        issue_state: str(content.state),
        status_option_id: str(status?.optionId),
        parent: linkedIssue(obj(content.parent)),
        sub_issues: subIssues,
        base_branch: settings.baseBranch,
        dispatch_note: null,
      },
      identifier: `${repository}#${number}`,
      title,
      description,
      priority: priorityOf(obj(item.priority), meta),
      state,
      branch_name: str(obj(nodes(content.linkedBranches)[0]?.ref)?.name),
      url: str(content.url),
      assignee_id: assignees[0] ?? null,
      labels: normalizeLabels(nodes(content.labels).map((l) => l.name)),
      blocked_by: blockers.filter((b) => b.id !== null || b.identifier !== null || b.state !== null),
      dispatchable: false,
      created_at: date(content.createdAt),
      updated_at: date(content.updatedAt),
  };
  applyDispatchRules(issue, gates, settings);
  return { kind: 'issue', issue, textBlockers: parseTextBlockers(description, repository, number), gates };
}

/** Single-select priorities rank by option order (first option = 1); number fields must be integers. */
function priorityOf(value: Json | null, meta: ProjectMeta): number | null {
  if (value === null || meta.priority === null) return null;
  if (meta.priority.kind === 'number') {
    return typeof value.number === 'number' && Number.isInteger(value.number) ? value.number : null;
  }
  const optionId = str(value.optionId);
  const index = meta.priority.options.findIndex((option) => option.id === optionId);
  return index === -1 ? null : index + 1;
}
