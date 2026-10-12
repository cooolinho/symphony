# `.claude/`: Symphony's toolbox for all agents

Symphony loads this folder as the local Claude Code plugin `symphony` into **every** agent session, whatever repository
the issue belongs to (`claude.plugins: [./.claude]` in `WORKFLOW.md`). Whatever lives here applies to all repositories
Symphony works on.

| Folder | Contents | Invoked in the agent as |
|---|---|---|
| `skills/<name>/SKILL.md` | Skills: front matter with `name` and `description`, followed by the instructions | `symphony:<name>` |
| `agents/<name>.md` | Subagents (optional specialist personas: `architect`, `database-engineer`, `filament-developer`, `test-engineer`, `code-reviewer`) | `symphony:<name>` |
| `commands/<name>.md` | Slash commands (legacy form, prefer skills) | `/symphony:<name>` |
| `hooks/hooks.json` | Hooks; scripts next to it, referenced in the JSON via `${CLAUDE_PLUGIN_ROOT}` | automatic |
| `.claude-plugin/plugin.json` | Plugin manifest (name `symphony`) | – |

Empty folders contain a `.gitkeep` so git keeps them. Shipped are the skills `refactoring` (audit), `refactor-safely`
(implementation) and `auto-code` (autopilot, continuously plans waves of sub-issues) and `concept` (split on concept into Epic
and Sub-Issues in Backlog).

## What belongs here, what belongs in the repository?

Rule of thumb: knowledge belongs where it is versioned and where it applies.

| Knowledge | Location |
|---|---|
| Framework knowledge (Laravel, Livewire, Pest, Inertia …) | **Laravel Boost** in the repository. Symphony generates guidelines and skills to match its `composer.lock`. |
| Domain and project ("create invoices", tenant scoping) | **Repository**: `.ai/skills/` and `.ai/guidelines/` in Laravel projects, `.claude/skills/` otherwise |
| Project rules and pitfalls | **Repository**: `.ai/rules/` (Boost tool `record-rule`, skill `infer-conventions`) |
| Ways of working across all repositories (PR style, commits, checking without a UI, handing off to the board) | **here**, `skills/` |
| Personal preferences | `~/.claude/`, not loaded by Symphony |

Skills in the repository are also visible to you and your colleagues locally; they are versioned with the code and
reviewed in pull requests. Only what applies exclusively to unattended Symphony agents, and is the same in every
repository, belongs here.

## Rules for your own skills

- One skill, one task. The `description` says exactly *when* it applies: Claude decides from it whether to load the skill.
- Keep `SKILL.md` short; move details into files next to it and link to them.
- Skills are self-contained: scripts and reference files live outside the workspace. Reference them relative to
  `SKILL.md`; Claude Code tells the agent the skill directory when it loads the skill.
- No secrets in skills. Agents can read the files.
- In Laravel repositories, put your own skills in `.ai/skills/`, not `.claude/skills/`: Boost overwrites
  `.claude/skills` when it generates, and `.ai/` is agent-neutral (Claude Code, Cursor, Codex …). A skill of the same
  name in `.ai/skills/` replaces the Boost skill.

## Command skills (`/refactoring`, `/refactor-safely`, `/auto-code`, `/concept`)

If an issue description starts with `/<name>`, the agent loads the skill `symphony:<name>`, provided
`skills/<name>/SKILL.md` exists (mechanics: [docs/configuration.md](../docs/configuration.md#issue-commands)). These
skills additionally follow these rules:

- The folder name is the command: lowercase letters, digits and hyphens only. `name:` in the front matter is the same name.
- The `description` says that the skill is loaded only when the prompt asks for it. Otherwise Claude pulls it into
  unrelated sessions on its own.
- `argument-hint` names the arguments; the text uses `$ARGUMENTS`.
- The skill states clearly what it must **not** do (for example change nothing) and describes every phase with a
  verifiable result. Permissions are enforced by the role (`read_only`, `may_move_to`), not the skill; the skill is
  only the instructions.
- Sub-issues write dependencies literally as `Blocked by #N` (in English, even in German texts). That is the only form
  Symphony recognizes.
- If a command needs its own permissions or tools, add a role with `commands: [<name>]` to `WORKFLOW.md`. Dispatch
  validation then checks that the skill exists.
- `test/workflow-prompt.test.ts` checks for every skill that name and folder match and that all linked files exist.

Anyone working on Symphony itself with Claude Code sees the skills from `skills/` as well.
