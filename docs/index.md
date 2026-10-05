# Dokumentation

Zentrale Übersicht über alle Dokumente zu Symphony. Einen Überblick über das Projekt gibt die
[README](../README.md).

## Einstieg

- [Getting Started](getting-started.md): Voraussetzungen, Installation, Board, Token, `.env`, Dry Run und Start
- [Docker](docker.md): Betrieb per Docker Compose hinter Traefik: Einrichtung, Update, Backup, Fehlerbilder und Sicherheit
- [Usage](usage.md): Ablauf eines Issues, Eingreifen im Betrieb, Modellwahl, `repo-init`, Dashboard und API, Logs und
  Kosten, mehrere Repositories, Laravel Boost, Sicherheit und Fehlerbehebung

## Referenz

- [configuration.md](configuration.md): alle Optionen der `WORKFLOW.md`, `$VARIABLE`-Verweise, Hooks und Prompt-Variablen
- [adapters/github-project.md](adapters/github-project.md): GitHub-Projects-Adapter, also Einstellungen, Normalisierung, Agenten-Tools und Fehler
- [agent-claude.md](agent-claude.md): Ablauf der Claude-Code-Sessions, Berechtigungen, Skills und Plugins, Laravel Boost, Zeitlimits und Kostenzählung
- [conformance.md](conformance.md): Abweichungen von der Spezifikation und eigene Festlegungen
- [laravel-repositories.md](laravel-repositories.md): Konventionen für Laravel-Repositories (auf Englisch)
- [e2e.md](e2e.md): End-to-End-Test der Orchestrierung sowie der Laravel-Integrationstest (`npm run test:laravel`)
