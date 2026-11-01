# Symphony für Laravel × Claude Code

![Projektvorschau](docs/preview.gif)

[English](README.md) | **Deutsch**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node.js 26](https://img.shields.io/badge/Node.js-26-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?logo=claude&logoColor=white)
![Laravel Boost](https://img.shields.io/badge/Laravel_Boost-FF2D20?logo=laravel&logoColor=white)

Eine autonome Coding-Pipeline: Du schiebst ein GitHub-Issue nach **Ready**, und Symphony übergibt es einem Team aus
**Claude-Code**-Agenten. Ein Analyst arbeitet die Anforderungen heraus, ein Architect entwirft größere Änderungen, ein
Developer setzt sie in einem isolierten Workspace um, ein Test Engineer und ein nur lesender Reviewer prüfen das
Ergebnis, und sobald alle Checks grün sind, merged Symphony den Pull Request nach `develop`. Du verfolgst alles in
einem Live-Dashboard und greifst ein, wo ein Agent dich braucht.

## 📖 Über das Projekt

Dieses Repository ist mein Ansatz für agentengesteuerte Softwareentwicklung: ein dauerhaft laufender Dienst, der ein
Project Board in eine Arbeitswarteschlange für KI-Agenten verwandelt. Leitplanken machen den unbeaufsichtigten Betrieb
sicher: Entry-Checks vor jeder Übergabe, nur lesende Review- und Security-Rollen, begrenzte Review-Schleifen, Kosten-
und Context-Budgets, Berechtigungsmodi und ein Merge-Gate. Was die Agenten lernen, halten sie in einem Wissens-Vault
fest (dem *Brain*), und **Laravel**-Projekte werden über **Laravel Boost** besonders gut unterstützt.

### Ursprung: die Symphony-Spezifikation von OpenAI

Symphony ist eine unabhängige Implementierung der
[**Symphony Service Specification**](https://github.com/openai/symphony/blob/main/SPEC.md) von OpenAI:

> Symphony is a long-running automation service that continuously reads work from a configured issue tracker, creates
> an isolated workspace for each issue, and runs a coding agent session for that issue inside the workspace.

Die Spezifikation legt den Kern fest: eine `WORKFLOW.md` mit Konfiguration und Prompt direkt beim Code, ein Workspace
pro Issue, eine Abfrageschleife mit begrenzter Parallelität, Abgleich, Wiederholungen und eine optionale HTTP-API. Als
Coding-Agent sieht sie den Codex-App-Server vor, den Tracker überlässt sie Adaptern. Diese Implementierung hält den
Vertrag ein ([Konformität](docs/conformance.md)) und erweitert ihn:

| Spezifikation | Diese Implementierung |
|---|---|
| Codex-App-Server | **Claude Code** über das [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) ([Zuordnung](docs/agent-claude.md)) |
| Austauschbarer Tracker | Adapter für **GitHub Projects (v2)**: Die Spalten des Boards steuern den Ablauf ([Profil](docs/adapters/github-project.md)) |
| Ein Agent pro Issue | **Eine Rolle pro Spalte**: Analyst, Architect, Developer, Test Engineer, Docs-Agent, Reviewer und Security-Auditor, dazu Befehlsrollen, die Sub-Issues anlegen |
| Der Agent entscheidet, wann er fertig ist | **Typisierte Ergebnisse und Checks**: Jede Stufe meldet ein Urteil, Entry-Checks sichern jede Übergabe, ein Merge-Gate führt vor dem Merge die CI des Repositories aus |
| Status-API | **Live-Dashboard** mit Team-Ansicht, Änderungs-Feed, Wissens-Vault und Statistik, dazu eine JSON-API |
| Beliebige Repositories | **Auf Laravel zugeschnitten**: Laravel Boost pro Workspace, eine Datenbank pro Workspace, Laravel-Check-Skripte und Subagents |

### Gebaut für Laravel-Projekte

Symphony funktioniert mit jedem Repository, ist aber auf Laravel-Anwendungen abgestimmt:

- **Laravel Boost automatisch.** Enthält ein Workspace eine Laravel-App mit `laravel/boost`, installiert Symphony die
  Composer-Abhängigkeiten, erzeugt Boosts Guidelines und Skills passend zu den installierten Paketversionen und hängt
  Boosts MCP-Server (Doku-Suche, Datenbankschema, Logs) an die Session. Generierte Dateien landen nie im Pull Request.
- **Eine Umgebung pro Issue.** [`hooks/laravel-env.sh`](hooks/laravel-env.sh) gibt jedem Workspace eine eigene `.env`
  und SQLite-Datenbank (optional MySQL); [`hooks/laravel-db-drop.sh`](hooks/laravel-db-drop.sh) räumt auf.
- **Laravel-Checks.** [`checks/laravel.sh`](checks/laravel.sh) führt vor jeder Übergabe Pint, statische Analyse und die
  Tests aus; mit `--full` läuft die ganze Suite parallel als CI-Gate vor dem Merge.
- **Laravel-Subagents.** Die gemeinsame Toolbox in [`.claude/`](.claude/README.md) bringt Spezialisten wie
  `laravel-filament-developer`, `laravel-database-engineer`, `laravel-test-engineer` und `laravel-code-reviewer` mit
  ([wie sie mit den Rollen zusammenspielen](docs/laravel-subagents.md)); die Konventionen für Repositories stehen in
  [docs/laravel-repositories.md](docs/laravel-repositories.md).

## ⚙️ So funktioniert es

```
Ready            Issue-Analyst: Anforderungen, Risiken, geschärfte Akzeptanzkriterien, Labels Type und Complexity
  ▼
Design           Architect (größere Änderungen): Ansatz und Schnittstellen, bei Bedarf Arbeitspakete als Sub-Issues
  ▼
In progress      Developer: Branch, Umsetzung, Tests, Pull Request
  ▼ Checks
Testing          Test Engineer: Tests für die Akzeptanzkriterien (Bug-, Feature- und Refactor-Issues)
  ▼
Documentation    Docs-Agent: nur wenn die Änderung Doku braucht
  ▼ Checks
Agent review     Reviewer (nur lesend) ──── Änderungen nötig ────▶ zurück nach In progress
  ▼
Security review  Security-Auditor (nur lesend): nur bei sicherheitsrelevanten Änderungen
  ▼ ci, prod-smoke
In review        Merge-Gate: Symphony merged per Squash nach develop (auto_merge), oder der Pull Request wartet auf dich
  ▼
Done             Workspace gelöscht; mit Brain landet eine Issue-Zusammenfassung im Vault

Blocked          ein Agent braucht dich: offene Fragen, kaputte Umgebung oder Rundenlimit (Label needs-human)
```

Symphony fragt ein **GitHub Project Board** ab und übergibt jedes Issue in einer aktiven Spalte an die Rolle dieser
Spalte. Jedes Issue bekommt einen eigenen Workspace: einen Klon des Repositories auf dem Branch
`symphony/issue-<nummer>`. Eine Stufe endet mit einem typisierten Ergebnis (`report_result`); Symphony postet es im
Issue, führt die Entry-Checks der nächsten Spalte aus und verschiebt die Karte. Kleine Issues überspringen Stufen, die
sie nicht brauchen, ohne eine Session zu starten.

Was die Agenten tun, steht in der **`WORKFLOW.md`** (Einstellungen und gemeinsamer Prompt) und in den Rollen-Prompts,
die sie aus **`roles/<rolle>.md`** einbindet. Board, Repositories, Modelle, Tokens und Schalter stehen in der **`.env`**.

## ✨ Features

### Pipeline

- **Board-gesteuert:** Die Spalten deines GitHub Project Boards steuern den Ablauf, Reihenfolge nach Priorität und
  Alter, mit begrenzter Parallelität gesamt und pro Spalte. Offene Blocker und Sub-Issues werden respektiert; eine
  Instanz kann mehrere Repositories bedienen.
- **Multi-Agent-Pipeline:** Jede Stufe übergibt mit einem typisierten Ergebnis (`report_result`), statt die Karte selbst
  zu verschieben. Symphony berechnet die nächste Spalte aus dem Urteil, pro Issue-Typ über Workflow-Profile, und begrenzt
  Review-, Test- und Security-Schleifen mit Rundenlimits; am Limit wartet das Issue mit dem Label `needs-human` auf dich
  ([Architektur](docs/concepts/multi-agent.md), [Ergebnisverträge](docs/results.md),
  [Runden und manuelles Fortsetzen](docs/usage.md#rounds-limits-and-manual-resume)).
- **Architect:** Größere Änderungen laufen zuerst durch die Spalte `Design`: Ein nur lesender Architect legt den Ansatz
  fest, bevor der Developer ihn umsetzt ([Details](docs/configuration.md#the-architect)).
- **Arbeitspakete:** Ein sehr großes Feature (Complexity `XL`) kann der Architect in Arbeitspakete aufteilen, je ein
  Sub-Issue mit eigener Pipeline, eigenem Workspace, Branch und Pull Request. Das Eltern-Issue wartet, bis alle
  geschlossen sind; dann prüft der Reviewer den integrierten Base-Branch gegen dessen Akzeptanzkriterien
  ([Details](docs/configuration.md#work-packages-split),
  [warum](docs/concepts/multi-agent.md#work-packages-instead-of-an-integration-engineer)).
- **Test Engineer, Docs-Agent und Security-Auditor:** Ein unabhängiger Agent schreibt Tests für die
  Akzeptanzkriterien und darf nur Testdateien ändern ([Details](docs/configuration.md#the-test-engineer)); ein günstiger
  `haiku`-Agent aktualisiert die Doku, wenn die Änderung es braucht
  ([Details](docs/configuration.md#the-documentation-stage)); ein nur lesender Auditor prüft sicherheitsrelevante
  Änderungen wie Policies, Middleware, Routen und Migrationen ([Details](docs/configuration.md#the-security-auditor)).
- **Checks und Merge-Gate:** Vor jeder Übergabe laufen Entry-Checks (Lint, statische Analyse, Tests); scheitert einer,
  bleibt die Karte stehen und der Agent behebt den Fehler. Vor dem Merge führen die benannten Checks `ci` und
  `prod-smoke` die eigene CI des Repositories und einen Smoke-Test des Images aus, auf Wunsch als Commit-Statuses
  `symphony/*`. Mit `auto_merge` merged Symphony danach per Squash nach `develop` und schließt das Issue
  ([Merge-Gate](docs/adapters/github-project.md#merge-gate), [Auto-Merge](docs/usage.md#auto-merge-into-develop)).
- **Befehle im Issue:** Beginnt die Beschreibung mit einem Befehl, lädt Symphony einen Skill statt der normalen
  Pipeline: `/refactoring` auditiert eine Codebasis und legt Sub-Issues an, `/refactor-safely` setzt sie
  verhaltensneutral um, `/auto-code` entwickelt ein Projekt in Wellen weiter ([Autopilot](docs/usage.md#autopilot-auto-code)),
  `/concept` und `/plan` machen aus einem Konzept oder einer Liste ein Backlog
  ([Konzept](docs/usage.md#concept-to-backlog-concept), [Liste](docs/usage.md#list-to-backlog-plan)), und
  `/brain-garden` räumt den Wissens-Vault auf.
- **Bilder und Dateien im Issue:** Mockups, Screenshots und PDFs am Issue werden in den Workspace geladen, und die
  Agenten machen mit dem Headless-Chromium im Image Screenshots ihrer eigenen UI-Änderungen
  ([Details](docs/usage.md#images-and-files-in-the-issue)).

### Dashboard

- **Live-Übersicht:** System-Karten (CPU, Speicher, Platte, Last, Agent-Slots, GitHub-API-Budget), Alerts, das
  Context-Budget für das 5-Stunden-Fenster und die Woche, die arbeitenden Teams und ein Aktivitätsstrom, live
  aktualisiert per Server-Sent Events.
- **Tasks:** was läuft, was als Nächstes startet und warum ein Issue wartet (Spaltenlimits, Model-Holds, Backoff,
  Pausen, Blocker), mit Reglern für die Agent-Slots sowie Retry, Jetzt starten, Pausieren und Fortsetzen.
- **Team-Ansicht pro Issue:** die Stufen des Issues als Partitur, die laufende Session mit ihren Subagents, der
  Ausführungs-Trace (Prompts, Modell- und Tool-Aufrufe, Phasen, Tokens, Kosten), alle Sessions und das Transkript.
- **Changes:** ein Feed aller Commits, Merges und Brain-Änderungen nach Tagen, mit Diffs, Check-Status und Hotspots.
- **Brain:** Vitalwerte des Wissens-Vaults, das Review der Kandidaten-Notizen (Befördern, Verwerfen, Rückgängig), ein
  Link-Graph, die Ordnerstruktur und Write-Clashes mit Fassungsvergleich.
- **Statistik:** Kosten, Tokens und Agentenzeit pro Tag, Modell, Rolle und Repository, die Budget-Historie und jeder
  einzelne Lauf.

Details: [Dashboard und API](docs/usage.md#dashboard-and-api).

### Wissens-Vault (Brain)

- **Gemeinsames Gedächtnis:** ein Vault aus Markdown-Notizen mit YAML-Frontmatter für alle Repositories, unter Git.
  Agenten lesen und schreiben ihn nur über die `brain_*`-Tools; jeder Schreibvorgang ist ein Commit von
  `symphony-<rolle>`.
- **Mensch entscheidet:** Neue Notizen sind Kandidaten; nur ein Mensch befördert sie zu `approved`, im Dashboard oder in
  Obsidian. Freigegebene Notizen sind für Agenten nur lesbar, und Clash-Regeln verhindern, dass sich zwei Läufe
  gegenseitig überschreiben.
- **Obsidian im Browser:** Das Compose-Profil `brain` startet Obsidian auf demselben Vault hinter Traefik.
- **Wächst mit der Arbeit:** Nach jedem Merge schreibt Symphony eine Issue-Zusammenfassung; die Gärtner-Rolle schlägt
  Zusammenführungen und Korrekturen für Duplikate, Waisen und kaputte Links vor.

Details: [docs/brain.md](docs/brain.md).

### Betrieb

- **Budgets und Limits:** Erreicht das Claude-Abo sein Limit, versucht Symphony es erneut und wartet dann auf den
  Reset; das Limit eines einzelnen Modells pausiert nur dieses Modell. Ein Kostenbudget pro Issue und der
  Context-Füllstand pro Session halten lange Läufe im Rahmen ([Session-Limit](docs/usage.md#session-limit),
  [Kostenbudget](docs/usage.md#cost-budget-per-issue)).
- **Kosten pro Repository:** Jeder Lauf wird mit Modell, Effort, Tokens, geschätzten Kosten (aus
  [`model-costs.yml`](model-costs.yml)) und Agentenzeit protokolliert.
- **Robust:** Wiederholungen mit exponentiellem Backoff, Erkennung hängender Sessions, ein Agent stoppt, wenn sich sein
  Issue auf dem Board ändert, und die `WORKFLOW.md` lädt ohne Neustart nach.
- **Docker:** Ein Image mit Node, PHP, Composer, pnpm, yarn, gitleaks und Headless-Chromium läuft ohne Root-Rechte
  hinter Traefik; das Compose-Profil `ci` ergänzt einen Docker-Daemon und MySQL für das CI-Gate, `brain` ergänzt
  Obsidian ([docs/docker.md](docs/docker.md)).
- **Sicher voreingestellt:** Das GitHub-Token bleibt im Symphony-Prozess, die Agenten sehen es nie; lesende Rollen
  können keine Dateien ändern; das Dashboard lauscht auf `127.0.0.1`, solange du es nicht hinter einen Proxy mit
  Login stellst.

## 🤖 Claude-Modell und Effort pro Issue per Label

Labels am Issue wählen das **Claude-Modell** und den **Denkaufwand (Effort)** für den Developer, der daran arbeitet.

| Label | Wirkung |
|---|---|
| `Model: fable` | Claude Fable für komplexe Aufgaben mit hohem Risiko (Datenmodell, Rechte, Migrationen, große Upgrades) |
| `Model: opus` | Claude Opus für schwierige, offene Aufgaben (Architektur, knifflige Bugs, größere Features) |
| `Model: sonnet` | Claude Sonnet für die alltägliche Umsetzung |
| `Model: haiku` | Claude Haiku für kleine, klar umrissene Änderungen (Doku, Texte, Konfiguration) |
| `Model: claude-opus-5-5` | Auch jede vollständige Modell-ID funktioniert |
| `Effort: low` … `Effort: max` | Denkaufwand: `low`, `medium`, `high`, `xhigh`, `max` |

- Ohne Label nimmt der Developer `CLAUDE_MODEL` / `CLAUDE_EFFORT` aus der `.env` (`opus` ab Complexity L). Die Rollen
  mit fester Aufgabe behalten ihr eigenes Modell, nach dem Prinzip „stark planen, günstiger umsetzen“: Der Architect
  entwirft mit `opus` (`fable` ab L), Reviewer und Security-Auditor prüfen mit `opus`, der Docs-Agent schreibt mit
  `haiku` ([Model and effort per role](docs/usage.md#model-and-effort-per-role)).
- `npm run repo-init` legt die Modell- und Effort-Labels (und die Befehls-Labels) in deinen Repositories an.
- Mit `/auto-code … issue-models=auto` versieht der Autopilot jedes Sub-Issue mit einem Modell, das zur Aufgabe passt.

Details: [Modell](docs/usage.md#choosing-the-model-per-issue) und [Effort](docs/usage.md#choosing-the-effort-per-issue)
pro Issue wählen.

## 🧰 Tech-Stack

| | Technologie | Wofür |
|---|---|---|
| <img src="https://cdn.simpleicons.org/claude" width="24" alt="Claude"> | **Claude Code** + [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) | Coding-Agenten: Sessions, Turns, Berechtigungsmodi, Plugins, Skills, Subagents |
| <img src="https://cdn.simpleicons.org/anthropic" width="24" alt="Anthropic"> | **Claude Fable / Opus / Sonnet / Haiku** | Modelle pro Rolle und pro Issue, mit Effort pro Issue |
| <img src="https://cdn.simpleicons.org/nodedotjs" width="24" alt="Node.js"> | **Node.js 26** | Laufzeit; führt TypeScript direkt aus, Tests mit `node:test` |
| <img src="https://cdn.simpleicons.org/typescript" width="24" alt="TypeScript"> | **TypeScript** | Orchestrator, Dashboard und Tools, geprüft mit `tsc` |
| <img src="https://cdn.simpleicons.org/github" width="24" alt="GitHub"> | **GitHub Projects v2, GraphQL- & REST-API** | Tracker: Spalten, Issues, Sub-Issues, Labels, Pull Requests, Commit-Statuses |
| <img src="https://cdn.simpleicons.org/githubactions" width="24" alt="GitHub Actions"> | **GitHub Actions** | CI (`npm run check`, Docker-Build und Starttest) |
| <img src="https://cdn.simpleicons.org/modelcontextprotocol" width="24" alt="MCP"> | **Model Context Protocol** | Tracker- und Brain-Tools für die Agenten im Prozess; MCP-Server von Laravel Boost |
| <img src="https://cdn.simpleicons.org/laravel" width="24" alt="Laravel"> | **Laravel + Laravel Boost**, **PHP + Composer** | Zielprojekte: Boost pro Workspace, Workspaces vorbereiten, ihre Checks ausführen |
| <img src="https://cdn.simpleicons.org/obsidian" width="24" alt="Obsidian"> | **Obsidian** | Den Wissens-Vault im Browser prüfen und bearbeiten |
| <img src="https://cdn.simpleicons.org/googlechrome" width="24" alt="Chromium"> | **Playwright + Headless-Chromium** | UI-Screenshots der Agenten |
| <img src="https://cdn.simpleicons.org/docker" width="24" alt="Docker"> | **Docker + Docker Compose** | Betrieb auf einem Server, CI-Sidecars (Docker-in-Docker, MySQL) |
| <img src="https://cdn.simpleicons.org/traefikproxy" width="24" alt="Traefik"> | **Traefik** | Reverse Proxy mit HTTPS und Login für Dashboard und Obsidian |
| <img src="https://cdn.simpleicons.org/zod" width="24" alt="Zod"> | **Zod**, **LiquidJS**, **YAML** | Konfigurationsprüfung, Prompt-Templates, Front Matter |

## 🚀 Erste Schritte

Du brauchst Node.js ≥ 26, git mit SSH-Zugang zu GitHub, ein angemeldetes Claude Code und ein GitHub-Token mit den
Scopes `repo` und `project`. Lege ein GitHub Project Board mit den Spalten `Backlog`, `Ready`, `Design`,
`In progress`, `Testing`, `Documentation`, `Agent review`, `Security review`, `Blocked`, `In review` und `Done` an.

```bash
npm install
cp .env.example .env    # Board-Nummer, Repositories, Modell und Token
npm run repo-init       # Standard-Labels in deinen Repositories
npm run dry-run         # Setup prüfen, ohne Agenten zu starten
npm start               # Symphony starten
```

Auf einem Server läuft stattdessen das Docker-Image hinter Traefik (`docker compose up -d --build`); einen lokalen
Testlauf desselben Images ohne Traefik startest du mit `docker-compose.local.yml`. Den Wissens-Vault schaltest du mit
`SYMPHONY_BRAIN_ENABLED=true` ein, Obsidian mit dem Compose-Profil `brain`.

Schritt für Schritt: [docs/getting-started.md](docs/getting-started.md) und [docs/docker.md](docs/docker.md).

## 📋 Nutzung

Schiebe ein Issue nach `Ready`. Der Analyst arbeitet Anforderungen, Risiken und geschärfte Akzeptanzkriterien heraus und
setzt die Labels `Type:` und `Complexity:`, wo das Issue keine hat, oder stellt dir in `Blocked` eine Frage. Danach läuft
die Pipeline von allein: Design, Umsetzung, Tests, Doku, Review und Security-Audit, je nachdem, was das Issue braucht.
Mit `auto_merge` landet der Pull Request in `develop`, sobald das Review ihn freigegeben hat und alle Checks bestanden
sind; `develop` gibst du selbst nach `main` frei ([Git-Flow](docs/gitflow.md)).

Während es läuft, zeigt das Dashboard (`SYMPHONY_PORT`), wer woran arbeitet und warum ein Issue wartet. Kommentiere im
Issue, um einen Agenten zu lenken, setze Labels wie `Model: opus` oder `Effort: high`, pausiere oder wiederhole ein
Issue und befördere die Notizen, die die Agenten im Brain vorschlagen.

Alles Weitere steht in [docs/usage.md](docs/usage.md): der Lebenslauf eines Issues, Eingreifen während des Laufs,
Abhängigkeiten, Modellwahl, Befehle, Dashboard und API, Logs und Kosten, mehrere Repositories, Sicherheit und
Fehlersuche.

## 📁 Projektstruktur

```
symphony/
├── WORKFLOW.md                 # Einstellungen, Rollen, Checks und gemeinsamer Prompt (live neu geladen)
├── roles/                      # ein Prompt pro Rolle (issue-analyst.md, architect.md, developer.md, …)
├── checks/                     # Entry-Checks und CI-Gate: laravel.sh, repo.sh (benannte Checks ci, prod-smoke)
├── hooks/                      # Workspace-Hooks: laravel-env.sh (eigene .env und Datenbank), laravel-db-drop.sh
├── .claude/                    # Toolbox für alle Sessions, geladen als Plugin "symphony" (Skills, Agents, Commands)
├── bin/screenshot.mjs          # symphony-screenshot: PNG einer Seite mit Headless-Chromium, für Agenten
├── model-costs.yml             # Modellpreise für die Kostenschätzung (live neu geladen)
├── Dockerfile                  # Image mit Node, PHP, Composer, pnpm, yarn, git, gitleaks und Headless-Chromium
├── docker-compose.yml          # Betrieb hinter Traefik; Profile ci (Docker-in-Docker, MySQL) und brain (Obsidian)
├── docker-compose.local.yml    # lokaler Testlauf desselben Images ohne Traefik
├── docker/                     # Entrypoint, SSH-Known-Hosts und das Setup der CI-Sidecars
├── .env.example                # Vorlage für die .env
├── repo-init.ts                # interaktives Repository-Setup (Labels, Laravel-Boost-Issue)
├── scripts/                    # Demo-Dashboard, End-to-End- und Laravel-Tests, Historie auf einen Server übertragen
├── src/
│   ├── cli.ts, service.ts      # Einstiegspunkt, Start, Shutdown, Dry Run
│   ├── workflow/               # WORKFLOW.md laden und prüfen, Templates, Live-Reload
│   ├── tracker/                # GitHub-Projects-Adapter, Agenten-Tools, Merge-Gate und Auto-Merge
│   ├── orchestrator/           # Polling, Dispatch, Pipeline-Stufen, Abgleich, Wiederholungen
│   ├── agent/                  # Claude-Code-Sessions über das Claude Agent SDK, Modelle, Limits
│   ├── workspace/              # Workspaces pro Issue, Hooks, git
│   ├── brain/                  # Wissens-Vault: Tools, Index, Git-Versionierung, Zugriffslog, Befördern
│   ├── changes/                # Änderungs-Feed aus Commits, Merges und Brain-Änderungen
│   ├── history/, costs/        # Log pro Repository, Statistik, Kostenschätzung
│   ├── budget/, system/        # Context- und Rate-Limit-Budget, Host-Metriken
│   ├── http/                   # Dashboard-Seiten, Live-Updates und JSON-API
│   ├── laravel/, integrations/ # Laravel erkennen und Laravel Boost pro Workspace
│   ├── repo-init/              # repo-init: GitHub-REST-Client, Standard-Labels
│   └── util/                   # Hilfsfunktionen (.env, Pfade, Fehler, …)
├── test/                       # Tests mit node:test
└── docs/                       # Dokumentation (Einstieg: docs/index.md)
```

## 📚 Dokumentation

Einstieg: [docs/index.md](docs/index.md). Die Dokumentation ist auf Englisch.

- [docs/getting-started.md](docs/getting-started.md): Einrichtung Schritt für Schritt
- [docs/docker.md](docs/docker.md): Betrieb mit Docker hinter Traefik: Einrichtung, HTTPS, CI-Sidecars, Obsidian, Backup, Fehlersuche
- [docs/usage.md](docs/usage.md): Betrieb, Dashboard und API, Befehle, Logs und Kosten, Fehlersuche
- [docs/configuration.md](docs/configuration.md): jede Option der `WORKFLOW.md`, `$VARIABLE`-Verweise, Hooks und Prompt-Variablen
- [docs/adapters/github-project.md](docs/adapters/github-project.md): der GitHub-Projects-Adapter: Einstellungen, Agenten-Tools, Merge-Gate, Fehler
- [docs/agent-claude.md](docs/agent-claude.md): Claude-Code-Sessions, Berechtigungen, Skills und Plugins, Brain-Tools, Kostenabrechnung
- [docs/brain.md](docs/brain.md): der Wissens-Vault: Aufbau, Frontmatter, Tools, Rollenschalter, Clash-Regeln, Obsidian, Backup und Zurücksetzen
- [docs/results.md](docs/results.md): Ergebnisverträge der Pipeline-Stufen: Arten, Urteile, das Tool `report_result`, Wiederherstellung
- [docs/concepts/multi-agent.md](docs/concepts/multi-agent.md): die Multi-Agent-Pipeline: Architektur, Entscheidungen und Spike-Ergebnisse
- [docs/conformance.md](docs/conformance.md): Abweichungen von der Spezifikation und implementierungsdefiniertes Verhalten
- [docs/laravel-repositories.md](docs/laravel-repositories.md) und [docs/laravel-subagents.md](docs/laravel-subagents.md): Laravel-Konventionen und -Subagents
- [docs/gitflow.md](docs/gitflow.md): Branches, Pull Requests, Merges und Releases
- [docs/e2e.md](docs/e2e.md): End-to-End-Test der Orchestrierung und der Laravel-Integrationstest

## 🛠️ Entwicklung

```bash
npm test                 # Tests
npm run typecheck        # TypeScript-Prüfung
npm run check            # beides
node scripts/demo.ts     # Dashboard mit erfundenen Daten auf http://127.0.0.1:4000 (ohne GitHub, ohne Claude)
npm run e2e              # End-to-End-Test auf einem Test-Board (legt echte Issues an)
npm run test:laravel     # Laravel-Integration gegen eine echte App (braucht PHP 8.3+, Composer, Netzwerk)
```

Jede Änderung geht per Pull Request nach `develop`; Releases gehen mit einem Release-Pull-Request und einem Tag
`vX.Y.Z` von `develop` nach `main` ([Git-Flow](docs/gitflow.md)). Die CI ([.github/workflows/ci.yml](.github/workflows/ci.yml))
führt für jeden Pull Request `npm run check` auf Node 26 aus und baut und startet das Docker-Image. Symphonys eigene
Agenten arbeiten auch an diesem Repository: Ihre Pull Requests merged das Merge-Gate nach `develop`, sobald das Review
sie freigegeben hat und alle Checks bestanden sind. Für Setups, deren Agenten direkt auf den Default-Branch zielen,
merged [.github/workflows/automerge.yml](.github/workflows/automerge.yml) Agenten-Pull-Requests nach der CI per Squash;
Pull Requests aus Forks, mit dem Label `manual-merge`, ohne verknüpftes Issue oder mit Änderungen an `.github/` oder den
Paketdateien überlässt es einem Menschen.

## 🔗 Referenzen

- [Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md) und die
  [Referenzimplementierung](https://github.com/openai/symphony) (OpenAI, Apache-2.0)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
  [Claude-Code-Einstellungen und Sandbox](https://code.claude.com/docs/en/settings#sandbox-settings),
  [Plugins](https://code.claude.com/docs/en/plugins) und [Skills](https://code.claude.com/docs/en/skills)
- [Laravel Boost](https://laravel.com/docs/boost) und [Agent Skills](https://agentskills.io/what-are-skills)
- [GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects) und
  [die Projects-API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [Obsidian](https://obsidian.md) und das [Obsidian-Image von linuxserver.io](https://docs.linuxserver.io/images/docker-obsidian/)
- [LiquidJS](https://liquidjs.com/), die Template-Sprache des Prompts

## 🤝 Mitwirken

Siehe [CONTRIBUTING.md](CONTRIBUTING.md). Sicherheitslücken bitte vertraulich melden, siehe [SECURITY.md](SECURITY.md).

## 📄 Lizenz

[MIT](LICENSE): forken, ändern, ausliefern. Die verwendeten Pakete haben eigene Lizenzen; das Claude Agent SDK
unterliegt den Nutzungsbedingungen von Anthropic.
