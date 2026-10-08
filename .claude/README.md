# `.claude/`: Symphonys Toolbox für alle Agenten

Symphony lädt diesen Ordner als lokales Claude-Code-Plugin `symphony` in **jede** Agent-Session, egal zu welchem
Repository das Issue gehört (`claude.plugins: [./.claude]` in der `WORKFLOW.md`). Was hier liegt, gilt also für alle
Repositories, die Symphony bearbeitet.

| Ordner | Inhalt | Aufruf im Agenten |
|---|---|---|
| `skills/<name>/SKILL.md` | Skills: Frontmatter mit `name` und `description`, darunter die Anleitung | `symphony:<name>` |
| `agents/<name>.md` | Subagents (optionale Spezialisten-Personas: `architect`, `database-engineer`, `filament-developer`, `test-engineer`, `code-reviewer`) | `symphony:<name>` |
| `commands/<name>.md` | Slash-Commands (Altform, besser Skills) | `/symphony:<name>` |
| `hooks/hooks.json` | Hooks; Skripte daneben, im JSON über `${CLAUDE_PLUGIN_ROOT}` referenziert | automatisch |
| `.claude-plugin/plugin.json` | Plugin-Manifest (Name `symphony`) | – |

Leere Ordner enthalten eine `.gitkeep`, damit Git sie behält. Mitgeliefert sind die Skills `refactoring` (Audit),
`refactor-safely` (Umsetzung) und `auto-code` (Autopilot, plant fortlaufend Wellen von Sub-Issues).

## Was gehört hierher, was ins Repository?

Faustregel: Wissen gehört dorthin, wo es versioniert wird und wo es gilt.

| Wissen | Ort |
|---|---|
| Framework-Wissen (Laravel, Livewire, Pest, Inertia …) | **Laravel Boost** im jeweiligen Repository. Symphony erzeugt Guidelines und Skills passend zur `composer.lock`. |
| Domäne und Projekt („Rechnungen erstellen“, Mandanten-Scoping) | **Repository**: in Laravel-Projekten `.ai/skills/` und `.ai/guidelines/`, sonst `.claude/skills/` |
| Projektregeln und Fallen | **Repository**: `.ai/rules/` (Boost-Tool `record-rule`, Skill `infer-conventions`) |
| Arbeitsweise über alle Repositories (PR-Stil, Commits, Prüfen ohne UI, Übergabe ans Board) | **hier**, `skills/` |
| Persönliche Vorlieben | `~/.claude/`, lädt Symphony nicht |

Skills im Repository sehen auch du und deine Kollegen lokal, sie werden mit dem Code versioniert und im Pull Request
geprüft. Hier landet nur, was ausschließlich für unbeaufsichtigte Symphony-Agenten gilt und in jedem Repository gleich
ist.

## Regeln für eigene Skills

- Ein Skill, eine Aufgabe. Die `description` sagt genau, *wann* er greift: danach entscheidet Claude, ob er ihn lädt.
- `SKILL.md` kurz halten, Details in Dateien daneben auslagern und darauf verweisen.
- Skills sind eigenständig: Skripte und Referenzdateien liegen außerhalb des Workspaces. Gib sie relativ zur
  `SKILL.md` an, Claude Code nennt dem Agenten beim Laden das Skill-Verzeichnis.
- Keine Geheimnisse in Skills. Agenten können die Dateien lesen.
- In Laravel-Repositories eigene Skills nach `.ai/skills/` legen, nicht nach `.claude/skills/`: Boost überschreibt
  `.claude/skills` beim Generieren, `.ai/` ist agentenneutral (Claude Code, Cursor, Codex …). Ein gleichnamiger Skill in
  `.ai/skills/` ersetzt den Boost-Skill.

## Befehls-Skills (`/refactoring`, `/refactor-safely`, `/auto-code`)

Beginnt die Beschreibung eines Issues mit `/<name>`, lädt der Agent den Skill `symphony:<name>`, sofern `skills/<name>/SKILL.md`
existiert (Technik: [docs/configuration.md](../docs/configuration.md#issue-commands)). Für solche Skills gilt zusätzlich:

- Der Ordnername ist der Befehl: nur Kleinbuchstaben, Ziffern und Bindestriche. `name:` im Frontmatter ist derselbe Name.
- Die `description` sagt, dass der Skill nur auf Verlangen des Prompts geladen wird. Sonst zieht Claude ihn in fremden
  Sessions von selbst heran.
- `argument-hint` nennt die Argumente, im Text steht `$ARGUMENTS`.
- Der Skill sagt klar, was er **nicht** darf (z. B. nichts ändern) und beschreibt jede Phase mit einem prüfbaren Ergebnis.
  Rechte erzwingt die Rolle (`read_only`, `may_move_to`), nicht der Skill. Er ist nur die Anleitung.
- Sub-Issues schreiben Abhängigkeiten wörtlich als `Blocked by #N` (Englisch, auch in deutschen Texten). Nur das erkennt
  Symphony.
- Braucht ein Befehl eigene Rechte oder Tools, gehört eine Rolle mit `commands: [<name>]` in die `WORKFLOW.md`. Dann
  prüft die Dispatch-Validierung, dass der Skill existiert.
- `test/workflow-prompt.test.ts` prüft für jeden Skill, dass Name und Ordner übereinstimmen und alle verlinkten Dateien
  existieren.

Wer an Symphony selbst mit Claude Code arbeitet, sieht die Skills aus `skills/` ebenfalls.
