import { candidateAppDirs, classifyComposer } from '../laravel/detect.ts';
import { errorMessage } from '../util/errors.ts';
import type { GithubIssueRef, GithubRestClient } from './github-rest.ts';
import type { InitTask } from './tasks.ts';

/** Title of the setup issue; also how the task recognizes an issue it created before. */
export const BOOST_ISSUE_TITLE = 'Laravel Boost einrichten';

export interface LaravelAppFacts {
  /** Directory relative to the repository root; '' for the root. */
  dir: string;
  boost: boolean;
}

export type BoostPlan =
  | { kind: 'none'; truncated: boolean }
  | { kind: 'installed'; apps: LaravelAppFacts[] }
  | { kind: 'open'; apps: LaravelAppFacts[]; issue: GithubIssueRef }
  | { kind: 'create'; apps: LaravelAppFacts[]; truncated: boolean };

/** Finds the repository's Laravel apps on its default branch and whether an issue is needed. */
export async function planBoostSetup(github: GithubRestClient, repository: string): Promise<BoostPlan> {
  const branch = await github.getDefaultBranch(repository);
  const tree = await github.getTree(repository, branch);
  const apps: LaravelAppFacts[] = [];
  for (const dir of candidateAppDirs(tree.paths)) {
    const text = await github.getFileText(repository, dir === '' ? 'composer.json' : `${dir}/composer.json`, branch);
    let json: unknown = null;
    try {
      json = text === null ? null : JSON.parse(text);
    } catch {
      // Not valid JSON: not an app we can classify.
    }
    const facts = classifyComposer(json);
    if (facts.laravel) apps.push({ dir, boost: facts.boost });
  }
  if (apps.length === 0) return { kind: 'none', truncated: tree.truncated };
  if (apps.every((app) => app.boost)) return { kind: 'installed', apps };
  const issue = await github.findOpenIssue(repository, BOOST_ISSUE_TITLE);
  return issue !== null ? { kind: 'open', apps, issue } : { kind: 'create', apps, truncated: tree.truncated };
}

function where(dir: string): string {
  return dir === '' ? 'im Repository-Root' : `in \`${dir}/\``;
}

function label(dir: string): string {
  return dir === '' ? '(root)' : `${dir}/`;
}

/** The setup issue a Symphony agent works through; German like the rest of the board. */
export function boostIssueBody(apps: readonly LaravelAppFacts[]): string {
  const missing = apps.filter((app) => !app.boost);
  const dirs = missing.map((app) => where(app.dir)).join(', ');
  const plural = missing.length > 1;
  return `Symphony nutzt [Laravel Boost](https://laravel.com/docs/boost) für Laravel-Apps: Guidelines und Skills passend zu den installierten Paketversionen sowie den MCP-Server \`laravel-boost\` (Doku-Suche, Datenbankschema, Logs). ${plural ? 'Die Laravel-Apps' : 'Die Laravel-App'} ${dirs} ${plural ? 'haben' : 'hat'} Boost noch nicht.

## Aufgabe

Jeweils im App-Verzeichnis (${missing.map((app) => (app.dir === '' ? 'Repository-Root' : `\`${app.dir}/\``)).join(', ')}):

1. Boost als Entwicklungsabhängigkeit installieren und für Claude Code einrichten. Ohne Terminal braucht Boost \`APP_ENV=local\` und eine \`boost.json\`, die den Agenten nennt:

   \`\`\`bash
   composer require laravel/boost --dev
   echo '{"agents": ["claude_code"]}' > boost.json
   APP_ENV=local php artisan boost:install --no-interaction --guidelines --skills --mcp
   \`\`\`

2. Generierte Dateien nicht committen (Empfehlung der Boost-Doku; \`boost:install\` und \`boost:update\` erzeugen sie neu, Symphony erzeugt sie in seinen Workspaces selbst). In die \`.gitignore\` des App-Verzeichnisses:

   \`\`\`gitignore
   /boost.json
   /.mcp.json
   /.claude/skills/
   \`\`\`

   Die Guideline-Datei (\`CLAUDE.md\`, falls vorhanden, sonst \`AGENTS.md\`) ebenfalls ignorieren, wenn Boost sie neu angelegt hat. Ist sie schon versioniert und handgeschrieben, hat Boost seinen Block \`<laravel-boost-guidelines>\` angehängt: entweder die handgeschriebenen Inhalte nach \`.ai/guidelines/\` verschieben (Boost übernimmt sie) und die Datei ignorieren, oder den Block wieder entfernen. Begründe die Wahl im Pull Request.

   Wichtig: Eine committete \`boost.json\` bedeutet für Symphony „das Repository verwaltet Boost selbst“, dann generiert Symphony nichts.

3. \`.ai/guidelines/\`, \`.ai/skills/\` und \`.ai/rules/\` anlegen (leere Ordner mit \`.gitkeep\`) und committen. Projektwissen gehört dorthin: Guidelines werden immer geladen, Skills bei Bedarf, Regeln nach Dateipfad.

4. Optional in der \`composer.json\` unter \`scripts\` ergänzen, damit Guidelines und Skills bei \`composer update\` aktuell bleiben:

   \`\`\`json
   "post-update-cmd": ["@php artisan boost:update --ansi"]
   \`\`\`

5. Prüfen: \`git status\` zeigt nur \`composer.json\`, \`composer.lock\`, \`.gitignore\` und \`.ai/\`; die Tests laufen weiter.

## Akzeptanzkriterien

- \`laravel/boost\` steht in \`require-dev\`, \`composer.lock\` ist aktualisiert.
- Von Boost generierte Dateien sind ignoriert, \`.ai/\` ist committet.
- Keine fachlichen Änderungen an der App.

Angelegt von \`npm run repo-init\` (Symphony). Nach dem Merge erkennt Symphony Boost automatisch (\`laravel.boost: auto\`) und erzeugt Guidelines, Skills und den MCP-Server in jedem Workspace.
`;
}

function describePlan(plan: BoostPlan): string[] {
  const apps = 'apps' in plan ? plan.apps.map((app) => `${label(app.dir)} ${app.boost ? 'with' : 'without'} Boost`).join(', ') : '';
  const lines: string[] = [];
  if (plan.kind === 'none') lines.push('– no Laravel app (root or one level deep)');
  else if (plan.kind === 'installed') lines.push(`✓ Laravel Boost installed: ${apps}`);
  else if (plan.kind === 'open') lines.push(`= open issue #${plan.issue.number} "${BOOST_ISSUE_TITLE}": ${plan.issue.url}`);
  else lines.push(`+ create issue "${BOOST_ISSUE_TITLE}" (${apps})`);
  if ((plan.kind === 'none' || plan.kind === 'create') && plan.truncated) {
    lines.push('! GitHub truncated the file list; apps further down may be missing');
  }
  return lines;
}

export const laravelBoostTask: InitTask = {
  id: 'laravel-boost',
  title: 'Laravel Boost',
  summary: 'issue that adds Laravel Boost to Laravel apps without it',

  async run({ repositories, github, terminal }) {
    let ok = true;
    const creates: Array<{ repository: string; apps: LaravelAppFacts[] }> = [];
    for (const repository of repositories) {
      terminal.print(repository);
      try {
        const plan = await planBoostSetup(github, repository);
        for (const line of describePlan(plan)) terminal.print(`  ${line}`);
        if (plan.kind === 'create') creates.push({ repository, apps: plan.apps });
      } catch (error) {
        ok = false;
        terminal.print(`  ✗ cannot read the repository: ${errorMessage(error)}`);
      }
    }
    if (creates.length === 0) {
      terminal.print('No issue needed.');
      return ok;
    }
    const count = creates.length === 1 ? 'an issue' : `${creates.length} issues`;
    if ((await terminal.confirm(`Create ${count} "${BOOST_ISSUE_TITLE}"?`, true)) !== true) {
      terminal.print('Cancelled; nothing changed.');
      return ok;
    }
    for (const { repository, apps } of creates) {
      try {
        const issue = await github.createIssue(repository, { title: BOOST_ISSUE_TITLE, body: boostIssueBody(apps) });
        terminal.print(`  ✓ ${repository}: issue #${issue.number} ${issue.url}`);
      } catch (error) {
        ok = false;
        terminal.print(`  ✗ ${repository}: ${errorMessage(error)}`);
      }
    }
    terminal.print('Add the new issues to the Symphony board (column Ready) so an agent picks them up.');
    return ok;
  },
};
