# Symphony für Laravel × Claude Code

[English](README.md) | **Deutsch**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node.js 26](https://img.shields.io/badge/Node.js-26-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?logo=claude&logoColor=white)
![Laravel Boost](https://img.shields.io/badge/Laravel_Boost-FF2D20?logo=laravel&logoColor=white)

Eine autonome Coding-Pipeline: Du schiebst ein GitHub-Issue nach **Ready**, und Symphony startet einen
**Claude-Code**-Agenten in einem isolierten Workspace. Er setzt das Issue um, testet, öffnet einen Pull Request und
übergibt ihn einem zweiten, nur lesenden Agenten zum Review. Du schaust dir nur noch das Ergebnis an.

Dieses Repository ist mein Ansatz für agentengesteuerte Softwareentwicklung: ein dauerhaft laufender Dienst, der ein
Project Board in eine Arbeitswarteschlange für KI-Agenten verwandelt. Leitplanken (Entry-Checks, eine Reviewer-Rolle,
Budgets, Berechtigungsmodi) machen den unbeaufsichtigten Betrieb sicher, und **Laravel**-Projekte werden über
**Laravel Boost** besonders gut unterstützt.

## 🧭 Ursprung: die Symphony-Spezifikation von OpenAI

Symphony ist eine unabhängige Implementierung der
[**Symphony Service Specification**](https://github.com/openai/symphony/blob/main/SPEC.md) von OpenAI:

> Symphony is a long-running automation service that continuously reads work from a configured issue tracker, creates
> an isolated workspace for each issue, and runs a coding agent session for that issue inside the workspace.

Die Spezifikation legt den Kern fest: eine `WORKFLOW.md` mit Konfiguration und Prompt direkt beim Code, ein Workspace
pro Issue, eine Abfrageschleife mit begrenzter Parallelität, Abgleich, Wiederholungen und eine optionale HTTP-API. Als
Coding-Agent sieht sie den Codex-App-Server vor, den Tracker überlässt sie Adaptern.

Diese Implementierung hält den Vertrag ein ([Konformität](docs/conformance.md)) und passt ihn an:

| Spezifikation | Diese Implementierung |
|---|---|
| Codex-App-Server | **Claude Code** über das [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) ([Zuordnung](docs/agent-claude.md)) |
| Austauschbarer Tracker | Adapter für **GitHub Projects (v2)**: Die Spalten des Boards steuern den Ablauf ([Profil](docs/adapters/github-project.md)) |
| Ein Agent pro Issue | **Rollen pro Spalte**: Ein Developer setzt um, ein lesender Reviewer prüft, Auditor, Autopilot, Analyst und Planner legen Sub-Issues an |
| Der Agent entscheidet, wann er fertig ist | **Entry-Checks** (Lint, statische Analyse, Tests) vor jeder Übergabe; scheitern sie, bleibt die Karte stehen |
| Beliebige Repositories | **Auf Laravel zugeschnitten**: Laravel Boost pro Workspace, eigene Datenbanken pro Workspace, ein Laravel-Check-Skript |

## 🐘 Gebaut für Laravel-Projekte

Symphony funktioniert mit jedem Repository, ist aber auf Laravel-Anwendungen abgestimmt:

- **Laravel Boost automatisch.** Enthält ein Workspace eine Laravel-App mit `laravel/boost`, installiert Symphony die
  Composer-Abhängigkeiten, erzeugt Boosts Guidelines und Skills passend zu den installierten Paketversionen und hängt
  Boosts MCP-Server (Doku-Suche, Datenbankschema, Logs) an die Session. Generierte Dateien landen nie im Pull Request.
  Das Dashboard zeigt, ob und wie der Agent Boost genutzt hat.
- **Eine Umgebung pro Issue.** Der `after_create`-Hook ([`hooks/laravel-env.sh`](hooks/laravel-env.sh)) gibt jedem
  Workspace eine eigene `.env` und SQLite-Datenbank (optional MySQL); [`hooks/laravel-db-drop.sh`](hooks/laravel-db-drop.sh)
  räumt auf.
- **Laravel-Checks.** [`checks/laravel.sh`](checks/laravel.sh) führt Pint, statische Analyse und die Tests aus, bevor ein
  Issue nach `Agent review` oder `In review` darf.
- **Laravel-Subagents.** Die gemeinsame Toolbox in [`.claude/`](.claude/README.md) bringt Spezialisten wie
  `laravel-filament-developer`, `laravel-database-engineer`, `laravel-test-engineer` und einen `laravel-code-reviewer`
  mit ([wie sie mit den Rollen zusammenspielen](docs/laravel-subagents.md)).
- **Konventionen für Repositories** (Agenten-Anweisungen, `.ai/`, Composer-Skripte, Boost) beschreibt
  [docs/laravel-repositories.md](docs/laravel-repositories.md).

## 🤖 Claude-Modell und Effort pro Issue per Label

Die sichtbarste Steuerung sitzt am Issue selbst: **Labels wählen das Claude-Modell und den Denkaufwand (Effort)** für den
Agenten, der daran arbeitet.

| Label | Wirkung |
|---|---|
| `Model: fable` | Claude Fable für komplexe Aufgaben mit hohem Risiko (Datenmodell, Rechte, Migrationen, große Upgrades) |
| `Model: opus` | Claude Opus für schwierige, offene Aufgaben (Architektur, knifflige Bugs, größere Features) |
| `Model: sonnet` | Claude Sonnet für die alltägliche Umsetzung |
| `Model: haiku` | Claude Haiku für kleine, klar umrissene Änderungen (Doku, Texte, Konfiguration) |
| `Model: claude-opus-5-5` | Auch jede vollständige Modell-ID funktioniert |
| `Effort: low` … `Effort: max` | Denkaufwand: `low`, `medium`, `high`, `xhigh`, `max` |

- Ohne Label gilt der Standard der Rolle (z. B. `opus` für den Reviewer), danach `CLAUDE_MODEL` / `CLAUDE_EFFORT` aus
  der `.env`.
- `npm run repo-init` legt die vier Modell-Labels und die fünf Effort-Labels (von hell nach dunkel eingefärbt) in deinen
  Repositories an.
- Mit `/auto-code … issue-models=auto` versieht der Autopilot-Agent jedes Sub-Issue mit einem passenden Modell-Label:
  Einfache Aufgaben bekommen ein günstiges Modell, schwierige ein starkes.
- Jeder Lauf wird pro Repository mit Modell, Tokens, geschätzten Kosten (aus [`model-costs.yml`](model-costs.yml)) und
  Agentenzeit protokolliert. So bleibt der Kompromiss zwischen Modell, Effort und Kosten messbar.

Details: [Modell](docs/usage.md#choosing-the-model-per-issue) und [Effort](docs/usage.md#choosing-the-effort-per-issue)
pro Issue wählen.

## 🧰 Tech-Stack

| | Technologie | Wofür |
|---|---|---|
| <img src="https://cdn.simpleicons.org/claude" width="24" alt="Claude"> | **Claude Code** + [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) | Coding-Agenten: Sessions, Turns, Berechtigungsmodi, Plugins, Skills, Subagents |
| <img src="https://cdn.simpleicons.org/anthropic" width="24" alt="Anthropic"> | **Claude Fable / Opus / Sonnet / Haiku** | Modelle, pro Issue per Label gewählt, mit Effort pro Issue |
| <img src="https://cdn.simpleicons.org/nodedotjs" width="24" alt="Node.js"> | **Node.js 26** | Laufzeit; führt TypeScript direkt aus, Tests mit `node:test` |
| <img src="https://cdn.simpleicons.org/typescript" width="24" alt="TypeScript"> | **TypeScript** | Der gesamte Orchestrator, geprüft mit `tsc` |
| <img src="https://cdn.simpleicons.org/github" width="24" alt="GitHub"> | **GitHub Projects v2, GraphQL- & REST-API** | Tracker: Spalten, Issues, Sub-Issues, Labels, Pull Requests |
| <img src="https://cdn.simpleicons.org/githubactions" width="24" alt="GitHub Actions"> | **GitHub Actions** | CI (`npm run check`, Docker-Build) und Auto-Merge der Agenten-Pull-Requests |
| <img src="https://cdn.simpleicons.org/laravel" width="24" alt="Laravel"> | **Laravel + Laravel Boost** | Zielprojekte; Boost-Guidelines, -Skills und MCP-Server pro Workspace |
| <img src="https://cdn.simpleicons.org/php" width="24" alt="PHP"> | **PHP + Composer** | Laravel-Workspaces vorbereiten und ihre Checks ausführen |
| <img src="https://cdn.simpleicons.org/modelcontextprotocol" width="24" alt="MCP"> | **Model Context Protocol** | Tracker-Tools für den Agenten im Prozess; MCP-Server von Laravel Boost |
| <img src="https://cdn.simpleicons.org/docker" width="24" alt="Docker"> | **Docker + Docker Compose** | Betrieb auf einem Server |
| <img src="https://cdn.simpleicons.org/traefikproxy" width="24" alt="Traefik"> | **Traefik** | Reverse Proxy mit HTTPS für das Dashboard |
| <img src="https://cdn.simpleicons.org/zod" width="24" alt="Zod"> | **Zod**, **LiquidJS**, **YAML** | Konfigurationsprüfung, Prompt-Templates, Front Matter |

## ⚙️ So funktioniert es

```
Backlog ─▶ Ready ─▶ In progress ─[Checks]─▶ Agent review ─[Checks]─▶ In review ─▶ Done
   │         │            │            ▲          │                     │          │
ignoriert  Analyst     Developer       └─ Ände-  Reviewer           wartet auf  Workspace
           dann Dev    arbeitet          rungen  prüft (nur          dich        gelöscht
                                         nötig   lesend)
                   Blocked: ein Agent braucht dich (Checks kaputt, Fragen offen)
```

Symphony fragt in einem festen Takt ein **GitHub Project Board** ab und übergibt Issues in aktiven Spalten an
**Claude Code**. Pro Issue legt Symphony einen eigenen Ordner an, klont dort das Repository und lässt den Agenten
arbeiten: Branch anlegen, implementieren, testen, pushen, Pull Request öffnen, Ergebnis im Issue kommentieren. Danach
prüfen automatische Checks und ein zweiter, lesender Agent (Reviewer) die Arbeit. Erst dann landet die Karte in
**In review**. Ab dort bist du dran: Review, Merge, Karte nach **Done**.
Bug-Issues durchlaufen vor dem Review eine Spalte `Testing` (ein unabhängiger Test Engineer). Review- und Test-Schleifen
sind begrenzt: Am Rundenlimit geht die Karte nach **Blocked** und bekommt das Label `needs-human`.

Was der Agent tun soll, steht in der **`WORKFLOW.md`** (Prompt und Einstellungen). Board, Repositories, Standardmodell
und Token stehen in der **`.env`**.

## ✨ Features

- **Board-gesteuert:** Die Spalten deines GitHub Project Boards steuern den Ablauf. Reihenfolge nach Priorität und
  Alter, begrenzte Parallelität (gesamt und pro Spalte), offene Blocker werden respektiert.
- **Isolierte Workspaces:** Pro Issue ein eigener Klon unter `~/symphony-workspaces`, bei Wiederholungen
  wiederverwendet und gelöscht, sobald das Issue auf *Done* steht.
- **Multi-Agent-Pipeline:** Analyst, Developer, optional Test Engineer und Reviewer übergeben jeweils mit einem
  typisierten Ergebnis (`report_result`), statt die Karte selbst zu verschieben. Symphony berechnet die nächste Spalte
  aus dem Urteil, pro Issue-Typ über Workflow-Profile, und begrenzt die Review- und Test-Schleifen durch
  Rundenlimits: Am Limit wartet das Issue mit dem Label `needs-human` auf dich
  ([Architektur](docs/concepts/multi-agent.md), [Ergebnis-Verträge](docs/results.md),
  [Runden und manuelles Fortsetzen](docs/usage.md#rounds-limits-and-manual-resume)).
- **Developer und Reviewer:** Rollen pro Spalte. Vor `Agent review` und `In review` laufen Checks (Lint, statische
  Analyse, Tests); scheitern sie, bleibt die Karte stehen und der Agent bessert nach.
- **Test Engineer:** Ein unabhängiger Agent in der Spalte `Testing` (Bug-Issues immer, andere Issues optional) schreibt Tests für die
  Akzeptanzkriterien und darf nur Testdateien ändern; fehlgeschlagene Tests gehen mit den betroffenen Fällen zurück an
  den Developer, und nach `pipeline.max_test_rounds` fehlgeschlagenen Runden wartet das Issue auf dich
  ([Details](docs/configuration.md#the-test-engineer)).
- **Befehle im Issue:** Beginnt die Beschreibung mit `/refactoring`, lädt Symphony einen zentral gepflegten Audit-Skill:
  Er misst die Baseline, findet Bugs und Refactoring-Kandidaten und legt Sub-Issues an. `/refactor-safely` setzt sie
  verhaltensneutral mit Tests als Sicherheitsnetz um ([Details](docs/usage.md#commands-in-the-issue-refactoring)).
- **Autopilot (`/auto-code`):** Ein Epic mit `/auto-code docs/index.md` lässt Symphony ein Projekt fortlaufend
  weiterentwickeln. Ein Autopilot-Agent leitet aus der Projektbeschreibung Wellen neuer Features, Design-, Qualitäts- und
  Wartungsaufgaben ab. Sie starten sofort und werden nach Review und Checks nach `develop` gemergt. Alle paar Wellen hält
  er an, mit Bericht und Release-PR nach `main` ([Details](docs/usage.md#autopilot-auto-code)).
- **Konzept und Liste ins Backlog:** `/concept docs/index.md` zerlegt ein Konzept in Epics und Sub-Issues
  ([Details](docs/usage.md#concept-to-backlog-concept)); `/plan docs/todo.md` oder `/plan` mit einer Liste darunter im
  Issue macht aus jedem Listenpunkt ein Sub-Issue mit ausführlichem Umsetzungsplan, Abhängigkeiten sowie Effort- und
  Modell-Labels, im Backlog ([Details](docs/usage.md#list-to-backlog-plan)).
- **Tracker-Tools für den Agenten:** Status setzen, kommentieren, Pull Request öffnen und (nur für die
  planenden Rollen) Sub-Issues anlegen. Der GitHub-Token bleibt im Symphony-Prozess, der Agent sieht ihn nie.
- **Robust:** Wiederholungen mit exponentiellem Backoff, Erkennung hängender Sessions; ändert sich das Issue auf dem
  Board, wird der Agent gestoppt.
- **Session-Limit-Handling:** Erreicht das Claude-Abonnement sein Limit, wiederholt Symphony ein paar Mal und wartet
  dann bis zum Reset. Das Limit eines einzelnen Modells (z. B. Fable) hält nur dieses Modell an: Seine Issues warten,
  die anderen Modelle laufen weiter, und kein Issue wechselt auf ein anderes Modell ([Details](docs/usage.md#session-limit)).
- **Live-Konfiguration:** Die `WORKFLOW.md` wird ohne Neustart neu geladen; eine Instanz kann mehrere Repositories
  bedienen.
- **Beobachtbar:** Dashboard mit JSON-API und einem Execution Trace pro Agent (Prompts, Modellaufrufe, Tool-Calls,
  Phasen, Tokens und Kosten), strukturierte Logs, ein Transkript pro Session, `--dry-run` zum Prüfen der Einrichtung.
- **Logs und Kosten pro Repository:** Ein fortlaufendes Log jedes Laufs mit Tokens, Modell, Effort, geschätzten Kosten
  und Agentenzeit, mit Statistiken im Dashboard; die Details beendeter Läufe bleiben in der Agent-Detailansicht abrufbar.

## 🚀 Getting Started

Du brauchst Node.js ≥ 26, git mit SSH-Zugriff auf GitHub, ein angemeldetes Claude Code und einen GitHub-Token mit den
Scopes `repo` und `project`.

```bash
npm install
cp .env.example .env    # Board-Nummer, Repository, Modell und Token eintragen
npm run dry-run         # Einrichtung prüfen, startet keine Agenten
npm start               # Symphony starten
```

Dazwischen legst du ein GitHub Project Board mit den Spalten `Backlog`, `Ready`, `In progress`, `Testing`,
`Agent review`, `Blocked`, `In review` und `Done` an. Die ausführliche Anleitung steht in
[docs/getting-started.md](docs/getting-started.md), den Betrieb per Docker hinter Traefik beschreibt
[docs/docker.md](docs/docker.md), einen lokalen Testlauf desselben Images ohne Traefik (`docker-compose.local.yml`)
[ein eigener Abschnitt](docs/docker.md#local-test-setup-without-traefik). Die Dokumentation unter `docs/` ist auf
Englisch.

## 📋 Usage

Du schiebst ein Issue nach `Ready`. Ein lesender Analyst-Agent arbeitet Anforderungen, Risiken und geschärfte
Akzeptanzkriterien heraus und setzt `Type:`- und `Complexity:`-Labels, wo das Issue keine hat (oder stellt dir eine
Frage in `Blocked`). Danach setzt ein Developer-Agent es um und öffnet einen Pull Request. Nach bestandenen
Checks prüft ein lesender Reviewer-Agent die Arbeit, danach landet die Karte in `In review`. Du mergst den Pull Request
und schiebst die Karte nach `Done`. Mit Labels wie `Model: sonnet` und `Effort: high` wählst du Modell und Effort pro
Issue; das Dashboard (`SYMPHONY_PORT`) zeigt, was läuft, was als Nächstes startet und warum ein Issue wartet, dazu
Logs und Kosten.

Alles Weitere steht in [docs/usage.md](docs/usage.md): Ablauf eines Issues, Eingreifen im Betrieb, Abhängigkeiten,
Modellwahl, `repo-init`, Dashboard und API, Logs und Kosten, mehrere Repositories, Konfiguration, Sicherheit,
Laravel Boost und Fehlerbehebung.

## 📁 Projektstruktur

```
symphony/
├── WORKFLOW.md                 # Rollen, Checks, Prompt und Einstellungen (wird live neu geladen)
├── hooks/laravel-env.sh        # after_create: eigene .env und SQLite-Datenbank pro Laravel-App (optional MySQL)
├── hooks/laravel-db-drop.sh    # before_remove: löscht die MySQL-Datenbanken des Workspaces
├── checks/laravel.sh           # Entry-Check vor Agent review und In review (Lint, Analyse, Tests)
├── .claude/                    # Toolbox für alle Sessions, geladen als Plugin "symphony" (Skills, Agents, Commands, Hooks)
├── .github/workflows/          # CI (npm run check) und automatisches Mergen der Agenten-Pull-Requests
├── model-costs.yml             # Modellpreise für die Kostenschätzung (wird live neu geladen)
├── Dockerfile                  # Image mit Node, PHP, Composer, git und SSH; läuft als Benutzer symphony
├── docker-compose.yml          # Betrieb hinter Traefik: Labels, Volumes, Secret für den SSH-Key
├── docker-compose.local.yml    # lokaler Testlauf desselben Images ohne Traefik, Dashboard auf 127.0.0.1
├── docker/                     # entrypoint.sh (Variablen prüfen, SSH-Key, git-Identität) und ssh_known_hosts
├── .env.example                # Vorlage für .env (Board, Repository, Modell, Token, Grenzen)
├── repo-init.ts                # interaktive Einrichtung der Repositories (Standard-Labels, Laravel-Boost-Issue)
├── scripts/e2e/                # End-to-End-Test der Orchestrierung auf einem echten Board (npm run e2e)
├── scripts/laravel-smoke/      # Integrationstest gegen eine echte Laravel-13/Filament-5-App (npm run test:laravel)
├── scripts/push-history.sh     # lokale Historie in den Symphony-Container eines Servers übertragen (docs/docker.md)
├── src/
│   ├── cli.ts                  # Einstiegspunkt: Optionen, .env laden, Start
│   ├── service.ts              # Start, Herunterfahren, Dry Run
│   ├── workflow/               # WORKFLOW.md laden, Konfiguration, Templates, Live-Reload, Prüfung
│   ├── tracker/                # Tracker-Schnittstelle und GitHub-Projects-Adapter samt Agenten-Tools und Auto-Merge
│   ├── workspace/              # Workspaces pro Issue und Hooks
│   ├── agent/                  # Claude-Code-Sessions über das Claude Agent SDK, Modell und Effort per Label
│   ├── laravel/                # Laravel-Apps erkennen, Laravel Boost pro Workspace vorbereiten
│   ├── orchestrator/           # Abfragen, Starten, Abgleichen, Wiederholungen
│   ├── history/                # Log pro Repository und Statistiken dazu
│   ├── costs/                  # model-costs.yml lesen, Kosten berechnen
│   ├── http/                   # Dashboard, Agent-Detailansicht, Logs-Seite und JSON-API
│   ├── repo-init/              # repo-init: Auswahlliste, GitHub-REST-Client, Standard-Labels, Boost-Issue
│   └── util/                   # Hilfsfunktionen (.env, Pfade, Fehler, …)
├── test/                       # Tests mit node:test
└── docs/                       # Dokumentation (Einstieg: docs/index.md)
```

## 📚 Dokumentation

Einstieg ist [docs/index.md](docs/index.md) (auf Englisch).

- [docs/getting-started.md](docs/getting-started.md): Einrichtung Schritt für Schritt
- [docs/docker.md](docs/docker.md): Betrieb mit Docker hinter Traefik: Einrichtung, Update, Backup, Fehlerbilder, Sicherheit
- [docs/usage.md](docs/usage.md): Betrieb, Konfiguration und Fehlerbehebung
- [docs/configuration.md](docs/configuration.md): alle Optionen der `WORKFLOW.md`, `$VARIABLE`-Verweise, Hooks und Prompt-Variablen
- [docs/adapters/github-project.md](docs/adapters/github-project.md): GitHub-Projects-Adapter: Einstellungen, Normalisierung, Agenten-Tools, Fehler
- [docs/agent-claude.md](docs/agent-claude.md): Claude-Code-Sessions, Berechtigungen, Skills und Plugins, Laravel Boost, Zeitlimits, Kostenzählung
- [docs/results.md](docs/results.md): Ergebnis-Verträge der Pipeline-Stages: Arten, Urteile, das Tool `report_result`, Recovery
- [docs/concepts/multi-agent.md](docs/concepts/multi-agent.md): die Multi-Agent-Pipeline: Architektur, Entscheidungen und Spike-Ergebnisse
- [docs/conformance.md](docs/conformance.md): Abweichungen von der Spezifikation und eigene Festlegungen
- [docs/laravel-repositories.md](docs/laravel-repositories.md): Konventionen für Laravel-Repositories
- [docs/e2e.md](docs/e2e.md): End-to-End-Test der Orchestrierung und Laravel-Integrationstest

## 🛠️ Entwicklung

```bash
npm test             # Tests
npm run typecheck    # TypeScript-Prüfung
npm run check        # beides
npm run e2e          # End-to-End-Test auf einem Test-Board (legt echte Issues an)
npm run test:laravel # Laravel-Integration gegen eine echte App (braucht PHP 8.3+, Composer, Netz)
```

Die CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) führt `npm run check` mit Node 26 sowie einen
Docker-Build mit Start-Test des Images für jeden Pull Request und jeden Push auf `main` aus. Ist sie für einen Pull
Request der Symphony-Agenten (Branch `symphony/*`) grün, mergt
[.github/workflows/automerge.yml](.github/workflows/automerge.yml) ihn per Squash, schließt die Issues, die er mit
`Closes #…` nennt, und löscht den Branch. Symphony startet dann die Issues, die davon abhängen. Der Auto-Merge läuft
immer in der Fassung von `main`: Ein Pull Request kann die Regeln für seinen eigenen Merge nicht ändern.

Ein Pull Request bleibt für dich offen, wenn

- er aus einem Fork kommt, auch von einem Branch `symphony/*` dort (der Workflow mergt nur Branches dieses Repositorys),
- er selbst oder ein Issue, das er schließt, das Label `manual-merge` hat,
- er kein Issue schließt,
- er `.github/`, `package.json` oder `package-lock.json` ändert (CI, Skripte, Abhängigkeiten) oder mehr als 100 Dateien,
- die CI fehlschlägt oder GitHub den Merge ablehnt, etwa wegen Konflikten mit `main`.

## 🔗 Referenzen

- [Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md) und die
  [Referenzimplementierung](https://github.com/openai/symphony) (OpenAI, Apache-2.0)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
  [Claude-Code-Einstellungen inkl. Sandbox](https://code.claude.com/docs/en/settings#sandbox-settings),
  [Plugins](https://code.claude.com/docs/en/plugins) und [Skills](https://code.claude.com/docs/en/skills)
- [Laravel Boost](https://laravel.com/docs/boost) und [Agent Skills](https://agentskills.io/what-are-skills)
- [GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects) und
  [Projects über die API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [LiquidJS](https://liquidjs.com/), die Template-Sprache des Prompts

## 🤝 Mitwirken

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) (englisch). Sicherheitslücken bitte privat melden, siehe [SECURITY.md](SECURITY.md).

## 📄 Lizenz

[MIT](LICENSE): forken, ändern, weitergeben. Die verwendeten Pakete haben eigene Lizenzen; das Claude Agent SDK
unterliegt den Nutzungsbedingungen von Anthropic.
