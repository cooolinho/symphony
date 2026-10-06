# Symphony

Arbeitet GitHub-Issues selbstständig ab: Für jedes Issue in einer aktiven Spalte deines GitHub Project Boards
startet Symphony eine eigene Claude-Code-Session in einem eigenen Workspace. Am Ende steht ein Pull Request, der auf
dein Review wartet.

## 📖 About

Symphony ist ein dauerhaft laufender Dienst. Er fragt in einem festen Takt ein **GitHub Project Board** ab und
übergibt bereitstehende Issues an **Claude Code**. Pro Issue legt Symphony einen eigenen Ordner an, klont dort das
Repository und lässt den Agenten arbeiten: Branch anlegen, implementieren, testen, pushen, Pull Request öffnen,
Ergebnis im Issue kommentieren. Danach prüfen automatische Checks und ein zweiter, lesender Agent (Reviewer) die
Arbeit. Erst dann landet die Karte in **In review**. Ab dort bist du dran: Review, Merge, Karte nach **Done**.

```
Backlog ─▶ Ready ─▶ In progress ─[Checks]─▶ Agent review ─[Checks]─▶ In review ─▶ Done
   │         │            │            ▲          │                     │          │
ignoriert  Developer   Developer       └─ Ände-  Reviewer           wartet auf  Workspace
           startet     arbeitet          rungen  prüft (nur          dich        gelöscht
                                         nötig   lesend)
                   Blocked: ein Agent braucht dich (Checks kaputt, Fragen offen)
```

Was der Agent tun soll, steht in der **`WORKFLOW.md`** (Prompt und Einstellungen). Board, Repository, Standardmodell
und Token stehen in der **`.env`**. Symphony ist eine Implementierung der
[Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md), die statt Codex
**Claude Code** über das Claude Agent SDK nutzt.

## ✨ Features

- **Board-gesteuert:** Die Spalten deines GitHub Project Boards (v2) steuern den Ablauf. Reihenfolge nach Priorität
  und Alter, begrenzte Parallelität (gesamt und pro Spalte), offene Blocker werden respektiert.
- **Isolierte Workspaces:** Pro Issue ein eigener Klon unter `~/symphony-workspaces`. Er wird bei Wiederholungen
  wiederverwendet und gelöscht, sobald das Issue auf *Done* steht.
- **Developer und Reviewer:** Rollen pro Spalte. Ein Developer-Agent implementiert, ein lesender Reviewer-Agent prüft.
  Vor `Agent review` und `In review` laufen Checks (Lint, statische Analyse, Tests); scheitern sie, bleibt die Karte
  stehen und der Agent bessert nach.
- **Claude Code als Agent:** Mehrere Turns pro Session, Modell frei wählbar (z. B. `opus`). Riskante Aktionen
  blockiert Claude Codes `auto`-Modus.
- **Modell pro Issue:** Ein Label wie `Model: sonnet` oder `Model: claude-opus-5-5` wählt das Modell für ein Issue.
  `npm run repo-init` legt die Labels `Model: opus`, `Model: sonnet` und `Model: haiku` in deinen Repositories an.
- **Effort pro Issue:** Ein Label wie `Effort: low` oder `Effort: max` wählt den Denkaufwand für ein Issue. Ohne Label
  gilt `CLAUDE_EFFORT` aus der `.env`. `repo-init` legt die fünf Labels `Effort: low` bis `Effort: max` ebenfalls an.
- **Laravel Boost automatisch:** Erkennt Symphony im Workspace eine Laravel-App mit `laravel/boost`, bekommt der
  Agent Boosts Guidelines, Skills und MCP-Server (Doku-Suche, Datenbankschema, Logs), passend zu den installierten
  Paketversionen. Generierte Dateien landen nie im Pull Request.
- **Skills für alle Repositories:** Der Ordner `.claude/` wird als Plugin `symphony` in jede Session geladen. Skills
  der Repositories und von Boost kommen dazu.
- **Tracker-Tools für den Agenten:** Status setzen, kommentieren, Pull Request öffnen. Der GitHub-Token bleibt
  dabei im Symphony-Prozess, der Agent sieht ihn nie.
- **Robust:** Wiederholungen mit exponentiellem Backoff, Erkennung hängender Sessions. Ändert sich das Board während
  ein Agent läuft, wird er gestoppt.
- **Session-Limit-Handling:** Erreicht das Claude-Abonnement sein Limit, wiederholt Symphony ein paar Mal und wartet
  dann bis zum Reset. Wartende und pausierte Worker startest du im Dashboard oder per API sofort neu
  ([Details](docs/usage.md#session-limit)).
- **Zentral konfigurierbar:** Die `WORKFLOW.md` wird live neu geladen, ohne Neustart. Die `.env` enthält Board,
  Repository, Modell und Token. Eine Instanz kann mehrere Repositories bedienen.
- **Beobachtbar:** Optionales Dashboard mit JSON-API und einer Detailansicht pro Agent (Execution Trace mit Prompts,
  Modellaufrufen, Tool-Calls, Phasen, Tokens und Kosten), strukturierte Logs, ein Transkript pro Session, `--dry-run`
  zum Prüfen der Einrichtung.
- **Logs und Kosten pro Repository:** Ein fortlaufendes Log hält fest, wann welches Issue bearbeitet wurde, mit
  Tokens, Modell, geschätzten Kosten und Agentenzeit. Die Kosten berechnet Symphony mit deinen Preisen aus der
  `model-costs.yml`. Eine Logs-Seite im Dashboard zeigt Statistiken, gesamt oder pro Repository.

## 🚀 Getting Started

Du brauchst Node.js ≥ 26, git mit SSH-Zugriff auf GitHub, ein angemeldetes Claude Code und einen GitHub-Token mit den
Scopes `repo` und `project`. Der Weg zum ersten Lauf in Kurzform:

```bash
npm install
cp .env.example .env    # Board-Nummer, Repository, Modell und Token eintragen
npm run dry-run         # Einrichtung prüfen, startet keine Agenten
npm start               # Symphony starten
```

Dazwischen legst du ein GitHub Project Board mit den Spalten `Backlog`, `Ready`, `In progress`, `Agent review`,
`Blocked`, `In review` und `Done` an. Die ausführliche Anleitung steht in
[docs/getting-started.md](docs/getting-started.md). Den Betrieb per Docker hinter Traefik beschreibt
[docs/docker.md](docs/docker.md).

## 📋 Usage

Du schiebst ein Issue nach `Ready`. Ein Developer-Agent setzt es um und öffnet einen Pull Request. Nach bestandenen
Checks prüft ein lesender Reviewer-Agent die Arbeit, danach landet die Karte in `In review`. Du mergst den Pull Request
und schiebst die Karte nach `Done`. Mit Labels wie `Model: sonnet` und `Effort: high` wählst du Modell und Denkaufwand pro Issue, das Dashboard
(`SYMPHONY_PORT`) zeigt laufende Agenten, Logs und Kosten.

Alles Weitere steht in [docs/usage.md](docs/usage.md): Ablauf eines Issues, Eingreifen im Betrieb, Abhängigkeiten,
Modellwahl, `repo-init`, Dashboard und API, Logs und Kosten, mehrere Repositories, Konfiguration, Sicherheit,
Laravel Boost und Fehlerbehebung.

## 📁 Project Structure

```
symphony/
├── WORKFLOW.md                 # Rollen, Checks, Prompt und Einstellungen (wird live neu geladen)
├── hooks/laravel-env.sh        # after_create: eigene .env und SQLite-Datenbank pro Laravel-App (optional MySQL)
├── hooks/laravel-db-drop.sh    # before_remove: löscht die MySQL-Datenbanken des Workspaces
├── checks/laravel.sh           # Entry-Check vor Agent review und In review (Lint, Analyse, Tests)
├── .claude/                    # Toolbox für alle Sessions, geladen als Plugin "symphony" (skills, agents, commands, hooks)
├── .github/workflows/          # CI (npm run check) und automatisches Mergen der Agenten-Pull-Requests
├── model-costs.yml             # Modellpreise für die Kostenschätzung (wird live neu geladen)
├── Dockerfile                  # Image mit Node, PHP, Composer, git und SSH; läuft als Benutzer symphony
├── docker-compose.yml          # Betrieb hinter Traefik: Labels, Volumes, Secret für den SSH-Key
├── docker/                     # entrypoint.sh (Variablen prüfen, SSH-Key, git-Identität) und ssh_known_hosts
├── .dockerignore               # hält .env, secrets/, Tests und Docs aus dem Build-Kontext
├── .env.example                # Vorlage für .env (Board, Repository, Modell, Token, Grenzen)
├── repo-init.ts                # interaktive Einrichtung der Repositories (Model-Labels, Laravel-Boost-Issue)
├── scripts/e2e/                # End-to-End-Test der Orchestrierung auf einem echten Board (npm run e2e)
├── scripts/laravel-smoke/      # Integrationstest gegen eine echte Laravel-13/Filament-5-App (npm run test:laravel)
├── scripts/push-history.sh     # lokale Historie per SSH in den Docker-Container eines Servers übertragen (docs/docker.md)
├── src/
│   ├── cli.ts                  # Einstiegspunkt: Optionen, .env laden, Start
│   ├── service.ts              # Start, Herunterfahren, Dry Run
│   ├── log.ts                  # strukturierte key=value-Logs
│   ├── workflow/               # WORKFLOW.md laden, Konfiguration, Templates, Live-Reload, Prüfung
│   ├── tracker/                # Tracker-Schnittstelle und GitHub-Projects-Adapter samt Agenten-Tools
│   ├── workspace/              # Workspaces pro Issue und Hooks
│   ├── agent/                  # Claude-Code-Sessions über das Claude Agent SDK, Modellwahl per Label
│   ├── laravel/                # Laravel-Apps erkennen, Laravel Boost pro Workspace vorbereiten
│   ├── orchestrator/           # Abfragen, Starten, Abgleichen, Wiederholungen
│   ├── history/                # Log pro Repository und Statistiken dazu
│   ├── costs/                  # model-costs.yml lesen, Kosten berechnen
│   ├── http/                   # Dashboard, Agent-Detailansicht (Execution Trace), Logs-Seite und JSON-API
│   ├── repo-init/              # repo-init: Auswahlliste, GitHub-REST-Client, Standard-Labels, Boost-Issue
│   └── util/                   # Hilfsfunktionen (.env, Pfade, Fehler, …)
├── test/                       # Tests mit node:test
└── docs/                       # Dokumentation (index.md als Einstieg)
```

## 📚 Documentation

Die zentrale Übersicht ist [docs/index.md](docs/index.md).

- [docs/getting-started.md](docs/getting-started.md): Einrichtung Schritt für Schritt
- [docs/docker.md](docs/docker.md): Betrieb mit Docker hinter Traefik, also Einrichtung, Update, Backup, Fehlerbilder und Sicherheit
- [docs/usage.md](docs/usage.md): Betrieb, Konfiguration und Fehlerbehebung
- [docs/configuration.md](docs/configuration.md): alle Optionen der `WORKFLOW.md`, `$VARIABLE`-Verweise, Hooks und Prompt-Variablen
- [docs/adapters/github-project.md](docs/adapters/github-project.md): GitHub-Projects-Adapter, also Einstellungen, Normalisierung, Agenten-Tools und Fehler
- [docs/agent-claude.md](docs/agent-claude.md): Ablauf der Claude-Code-Sessions, Berechtigungen, Skills und Plugins, Laravel Boost, Zeitlimits und Kostenzählung
- [docs/conformance.md](docs/conformance.md): Abweichungen von der Spezifikation und eigene Festlegungen
- [docs/laravel-repositories.md](docs/laravel-repositories.md): Konventionen für Laravel-Repositories, also Agenten-Anweisungen, `.ai/`, Composer-Skripte, `.env.example`, `phpunit.xml` und Boost
- [docs/e2e.md](docs/e2e.md): End-to-End-Test der Orchestrierung, also Szenario, Ablauf, Prüfungen und Run-Verzeichnis, sowie der Laravel-Integrationstest (`npm run test:laravel`)

Für die Entwicklung:

```bash
npm test            # Tests
npm run typecheck   # TypeScript-Prüfung
npm run check       # beides
npm run e2e         # End-to-End-Test auf dem Test-Board (legt echte Issues an)
npm run test:laravel # Laravel-Integration gegen eine echte App (braucht PHP 8.3+, Composer, Netz)
```

Die CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) führt `npm run check` mit Node 26 sowie einen Docker-Build
mit Start-Test des Images für jeden Pull Request und jeden Push auf `main` aus. Ist sie für einen Pull Request der Symphony-Agenten (Branch `symphony/*`) grün, mergt
[.github/workflows/automerge.yml](.github/workflows/automerge.yml) ihn per Squash, schließt die Issues, die er mit
`Closes #…` nennt, und löscht den Branch. Symphony startet dann die Issues, die davon abhängen. Das Schließen
übernimmt der Workflow selbst, weil GitHub `Closes #…` bei Merges durch den Actions-Token nicht auswertet; mergst du
selbst, schließt GitHub die Issues wie gewohnt. Der Auto-Merge läuft immer in der Fassung von `main`: Ein Pull
Request kann die Regeln für seinen eigenen Merge nicht ändern.

Ein Pull Request bleibt für dich offen, wenn

- er selbst oder ein Issue, das er schließt, das Label `manual-merge` hat,
- er kein Issue schließt,
- er `.github/`, `package.json` oder `package-lock.json` ändert (CI, Skripte, Abhängigkeiten) oder mehr als 100 Dateien,
- die CI fehlschlägt oder GitHub den Merge ablehnt, etwa wegen Konflikten mit `main`.

Solche Issues bleiben in `In review` stehen. Entfernst du `manual-merge` später wieder, starte den letzten
„Auto-merge“-Lauf im Actions-Tab neu, oder merge selbst. Für Nacharbeiten kommentiere im Issue und schiebe es zurück
nach `Ready`.

## 🔗 References

- [Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md) und die
  [Referenzimplementierung](https://github.com/openai/symphony) (OpenAI, Apache-2.0)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) und
  [Claude-Code-Einstellungen inkl. Sandbox](https://code.claude.com/docs/en/settings#sandbox-settings)
- [GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects) und
  [Projects über die API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [GitHub Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [LiquidJS](https://liquidjs.com/) (Template-Sprache des Prompts)
- [Laravel Boost](https://laravel.com/docs/boost) und [Agent Skills](https://agentskills.io/what-are-skills)
- [Claude-Code-Plugins](https://code.claude.com/docs/en/plugins) und [Skills](https://code.claude.com/docs/en/skills)

## 📄 License

Noch keine Lizenz festgelegt (privates Projekt). Die verwendeten Pakete haben eigene Lizenzen; das Claude Agent SDK
unterliegt den Nutzungsbedingungen von Anthropic.
