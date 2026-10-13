import type { IntegrationReport } from '../agent/types.ts';

/** Tool calls of one run: `tool_use` events per tool name, and Skill tool calls per skill. */
export interface ToolUsage {
  tools: Record<string, number>;
  skills: Record<string, number>;
}

/** Calls of one run attributed to an integration. */
export interface IntegrationUsage {
  /** Calls of the integration's MCP tools by bare tool name (summed over its servers). */
  tools: Record<string, number>;
  /** Skill tool calls of the integration's skills by skill name. */
  skills: Record<string, number>;
  calls: number;
}

export function emptyToolUsage(): ToolUsage {
  return { tools: {}, skills: {} };
}

export function countToolUse(usage: ToolUsage, tool: string, skill: string | null): void {
  usage.tools[tool] = (usage.tools[tool] ?? 0) + 1;
  if (skill !== null) usage.skills[skill] = (usage.skills[skill] ?? 0) + 1;
}

export function copyToolUsage(usage: ToolUsage): ToolUsage {
  return { tools: { ...usage.tools }, skills: { ...usage.skills } };
}

/** `mcp__<server>__<tool>` → server and tool; null for built-in tools. */
export function splitMcpTool(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match === null ? null : { server: match[1] as string, tool: match[2] as string };
}

/** A skill call matches a skill by name or plugin-qualified (`plugin:name`). */
export function skillMatches(called: string, name: string): boolean {
  return called === name || called.endsWith(`:${name}`);
}

export function integrationUsage(report: IntegrationReport, usage: ToolUsage): IntegrationUsage {
  const result: IntegrationUsage = { tools: {}, skills: {}, calls: 0 };
  for (const [name, count] of Object.entries(usage.tools)) {
    const mcp = splitMcpTool(name);
    if (mcp === null || !report.mcpServers.includes(mcp.server)) continue;
    result.tools[mcp.tool] = (result.tools[mcp.tool] ?? 0) + count;
    result.calls += count;
  }
  for (const [called, count] of Object.entries(usage.skills)) {
    const skill = report.skills.find((name) => skillMatches(called, name));
    if (skill === undefined) continue;
    result.skills[skill] = (result.skills[skill] ?? 0) + count;
    result.calls += count;
  }
  return result;
}

/**
 * An integration report with its usage in the run, for the API (GET /api/v1/state, /api/v1/<identifier>).
 * `skills_loaded` lists the integration's skills Claude Code reported at session start (null before that);
 * `mcp_unavailable` its MCP servers that did not connect, although the preparation succeeded.
 */
export function integrationJson(report: IntegrationReport, usage: ToolUsage, sessionSkills: string[] | null, mcpUnavailable: string[] = []) {
  const used = integrationUsage(report, usage);
  return {
    id: report.id,
    label: report.label,
    status: report.status,
    parts: report.parts.map((part) => ({
      name: part.name,
      status: part.status,
      reason: part.reason,
      versions: part.versions,
      guidelines: part.guidelines,
      skills: part.skills,
      mcp_server: part.mcpServer,
      tools: part.tools,
      warnings: part.warnings,
    })),
    mcp_servers: report.mcpServers,
    mcp_unavailable: report.mcpServers.filter((server) => mcpUnavailable.includes(server)),
    skills: report.skills,
    skills_loaded: sessionSkills === null ? null : report.skills.filter((name) => sessionSkills.some((loaded) => skillMatches(loaded, name))),
    usage: { calls: used.calls, tool_calls: used.tools, skill_calls: used.skills },
  };
}
