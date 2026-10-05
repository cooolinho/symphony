# Getting Started

## Voraussetzungen

| Was | Prüfen mit |
|---|---|
| Linux, WSL2 oder macOS mit **Node.js ≥ 26** und npm | `node --version` |
| **git** mit SSH-Zugriff auf GitHub (Symphony klont per SSH, der Agent pusht per SSH) | `ssh -T git@github.com` |
| **Claude Code**, angemeldet. Alternativ ein `ANTHROPIC_API_KEY` | `claude` starten, ggf. `/login` |
| **GitHub-Token** mit den Scopes `repo` und `project` | siehe Schritt 3 |
| Nur für Laravel-Repositories: **PHP** und **Composer** in den Versionen der Projekte | `php --version`, `composer --version` |

Das Claude Agent SDK bringt seine eigene Claude-Code-CLI mit. Es nutzt dieselbe Anmeldung wie dein installiertes
`claude`.

## 1. Installieren

```bash
cd ~/projects/symphony
npm install
```

## 2. GitHub Project Board einrichten

1. Lege auf GitHub unter **Profil → Projects → New project** ein Projekt mit der Vorlage **Kanban** an. Sie bringt die
   Spalten `Backlog`, `Ready`, `In progress`, `In review` und `Done` mit.
2. Ergänze die Spalten `Agent review` und `Blocked`: im Board über das Menü des Feldes **Status** (oder
   *Settings → Fields → Status*) zwei Optionen hinzufügen. Die Reihenfolge ist egal, übersichtlich ist:

   | Spalte | Wer schiebt hierher | Was Symphony tut |
   |---|---|---|
   | `Backlog` | du | nichts |
   | `Ready` | du | startet den **Developer** |
   | `In progress` | Developer, Reviewer (Änderungen nötig) | Developer arbeitet |
   | `Agent review` | Developer, nach bestandenen Checks | startet den **Reviewer** (höchstens einen gleichzeitig) |
   | `Blocked` | Developer oder Reviewer | stoppt den Agenten, Workspace bleibt; du bist dran |
   | `In review` | nur der Reviewer, nach bestandenen Checks | stoppt den Agenten, Workspace bleibt; dein Review |
   | `Done` | nur du | stoppt den Agenten und löscht den Workspace |

   Genau diese Namen erwartet die mitgelieferte `WORKFLOW.md`. Der Dry Run (Schritt 6) meldet jede Spalte, die auf
   dem Board fehlt (`unknown board column`).
3. Notiere die **Board-Nummer** aus der URL, z. B. `10` aus `https://github.com/users/cooolinho/projects/10`.
4. Füge Issues hinzu: im Board über **+ Add item** und dann `#` für ein Issue deines Repositories, oder in der
   Seitenleiste eines Issues unter **Projects**. Symphony bearbeitet nur echte Issues, keine Entwürfe und keine
   Pull Requests.
5. Optional: Abhängigkeiten und Sub-Issues anlegen. Symphony startet ein Issue erst, wenn alles erledigt ist, wovon es
   abhängt. Siehe [Abhängigkeiten und Sub-Issues](usage.md#abhängigkeiten-und-sub-issues).

> Heißen deine Spalten anders, zum Beispiel `Todo`, `In Progress`, `Human Review` und `Done` (andere Vorlage), passe
> `active_states`, `terminal_states`, `roles`, `checks.on_enter`, `agent.max_concurrent_agents_by_state` sowie die
> Statusnamen im Prompt der `WORKFLOW.md` an. Wichtig ist eine Übergabe-Spalte, die weder aktiv noch final ist (hier
> `In review`). Ohne sie hört der Agent nie auf, siehe
> [Fehlerbehebung](usage.md#fehlerbehebung).

## 3. GitHub-Token erstellen

Du hast zwei Möglichkeiten:

- **Klassischer Personal Access Token:** GitHub → *Settings → Developer settings → Personal access tokens →
  Tokens (classic) → Generate new token*. Wähle die Scopes **`repo`** und **`project`**. Mit einem klassischen
  Token funktionieren Boards in Benutzer- und Organisationskonten.
- **Den Login der GitHub-CLI wiederverwenden:**

  ```bash
  gh auth refresh -s project
  gh auth token
  ```

  Der zweite Befehl gibt den Token aus.

## 4. `.env` anlegen

```bash
cp .env.example .env
chmod 600 .env
```

Trage danach deine Werte ein:

```dotenv
GITHUB_PROJECT_NUMBER=10
GITHUB_REPOSITORY=cooolinho/trainingsstunden-portal
CLAUDE_MODEL=opus
GITHUB_TOKEN=ghp_…

# Orchestrator-Grenzen (optional, sonst gelten die Standardwerte aus der WORKFLOW.md)
SYMPHONY_MAX_CONCURRENT_AGENTS=1
SYMPHONY_MAX_TURNS=5
SYMPHONY_MAX_CONTINUATIONS=6
SYMPHONY_MAX_SESSION_LIMIT_RETRIES=3
SYMPHONY_POLL_INTERVAL_MS=30000
SYMPHONY_CLEANUP_TERMINAL=true
```

| Variable | Bedeutung |
|---|---|
| `GITHUB_PROJECT_NUMBER` | Nummer des Boards. Die ganze Board-URL geht auch. |
| `GITHUB_REPOSITORY` | `owner/name` des Repositories. Mehrere Repositories trennst du mit Kommas. Issues anderer Repositories auf dem Board werden ignoriert. |
| `CLAUDE_MODEL` | Standardmodell für Claude Code: Alias wie `opus` oder `sonnet`, oder eine volle Modell-ID. Leer heißt: Claude-Code-Standard. Ein Label `Model: …` am Issue hat Vorrang, siehe [Modell pro Issue wählen](usage.md#modell-pro-issue-wählen). |
| `GITHUB_TOKEN` | Token aus Schritt 3. Er wird aus der Umgebung von Agenten und Hooks entfernt. |
| `GITHUB_PROJECT_OWNER` | *optional:* Eigentümer des Boards, falls nicht der Repository-Eigentümer (z. B. eine Organisation) |
| `SYMPHONY_PORT` | *optional:* Port für Dashboard und API, z. B. `4000` für `http://127.0.0.1:4000/` |
| `SYMPHONY_HOST` | *optional:* Bind-Adresse des Dashboards. Standard `127.0.0.1`; `0.0.0.0` (etwa im Container) nur hinter einem Reverse-Proxy mit Anmeldung, siehe [Sicherheit](usage.md#sicherheit). |
| `SYMPHONY_ALLOW_REMOTE_CONTROL` | *optional:* `true` erlaubt **Retry now** / **Resume now** auch bei einer Nicht-Loopback-Adresse, dann nur mit passendem `Origin`-Header. Standard `false`. |
| `ANTHROPIC_API_KEY` | *optional:* Sonst nutzt Claude Code seine bestehende Anmeldung. |
| `SYMPHONY_MAX_CONCURRENT_AGENTS` | *optional:* Wie viele Agenten gleichzeitig laufen. Standard 2, `0` pausiert alle neuen Starts. |
| `SYMPHONY_MAX_TURNS` | *optional:* Turns pro Session, bevor Symphony den Stand neu bewertet. Standard 10. |
| `SYMPHONY_MAX_CONTINUATIONS` | *optional:* Wie viele weitere Sessions ein Issue bekommt, solange seine Karte aktiv bleibt. Jeder Wechsel zwischen Developer und Reviewer zählt mit. Danach **pausiert** Symphony das Issue, siehe [Fortsetzungen und Pausieren](usage.md#fortsetzungen-und-pausieren). Standard 6, leer heißt unbegrenzt. |
| `SYMPHONY_MAX_SESSION_LIMIT_RETRIES` | *optional:* Wie oft Symphony ein Issue nach dem ersten Session-Limit-Fehler erneut versucht, bevor der Worker auf das Reset wartet. Danach wartet er bis zum Reset (Reset + 1 Minute), siehe [Session-Limit](usage.md#session-limit). Standard 3, `0` heißt: sofort warten. |
| `SYMPHONY_POLL_INTERVAL_MS` | *optional:* Wie oft das Board abgefragt wird, in Millisekunden. Standard 30000. |
| `SYMPHONY_CLEANUP_TERMINAL` | *optional:* `true` (Standard) löscht den Workspace, sobald ein Issue in `Done` landet. Vorher läuft der `before_remove`-Hook, z. B. für eine Test-Datenbank. `false` behält die Workspaces. |
| `SYMPHONY_LOG_DIR` | *optional:* Ordner für Repository-Logs und Session-Transkripte. Standard: `~/.local/state/symphony`. Ein relativer Pfad gilt ab dem Symphony-Ordner, z. B. `logs`. |

Die `WORKFLOW.md` liest diese Werte über Verweise wie `$GITHUB_TOKEN` oder `${SYMPHONY_MAX_TURNS:-10}`. Die zweite
Form hat einen Standardwert, falls die Variable fehlt oder leer ist. Variablen, die in deiner Shell bereits gesetzt
sind, haben Vorrang vor der `.env`. Symphony meldet so einen Konflikt beim Start mit dem Variablennamen, nie mit dem
Wert. Nach Änderungen an der `.env` musst du Symphony neu starten.

## 5. Labels anlegen (optional)

Mit Labels wie `Model: sonnet` wählst du pro Issue das Modell, siehe [Modell pro Issue wählen](usage.md#modell-pro-issue-wählen).
Das Script `repo-init` legt sie in den Repositories aus `GITHUB_REPOSITORY` an:

```bash
npm run repo-init
```

Es führt dich durch eine Auswahlliste, zeigt vor jeder Änderung, was es anlegen würde, und fragt nach. Mehr dazu unter
[Repositories einrichten (repo-init)](usage.md#repositories-einrichten-repo-init).

## 6. Einrichtung prüfen (Dry Run)

```bash
npm run dry-run
```

Der Dry Run lädt `WORKFLOW.md` und `.env`, prüft die Konfiguration, liest das Board und zeigt, was Symphony
starten würde. Er prüft auch, ob `php` und `composer` für Laravel Boost laufen, und nennt für Issues mit bestehendem
Workspace die erkannten Laravel-Apps. Agenten startet er nicht. Beispiel:

```
Workflow:        /home/cooolinho/projects/symphony/WORKFLOW.md
Env file:        /home/cooolinho/projects/symphony/.env
Tracker:         github_project
Active states:   Ready, In progress, Agent review
…
Plugins:         /home/cooolinho/projects/symphony/.claude; skills: all
Laravel Boost:   auto, for Laravel apps that require laravel/boost; php (PHP 8.4.12), composer (Composer version 2.8.12 …)

Candidates in active states: 3
  dispatch  cooolinho/trainingsstunden-portal#12  [Ready]  Abrechnung als CSV exportieren
            ↳ Laravel app laravel/: Laravel Boost
  skip      cooolinho/trainingsstunden-portal#15  [Ready]  Export-Button im Dashboard
            ↳ blocked by cooolinho/trainingsstunden-portal#12
  skip      cooolinho/trainingsstunden-portal#16  [Ready]  Export-Funktion
            ↳ waiting for sub-issues cooolinho/trainingsstunden-portal#15

Prompt preview for cooolinho/trainingsstunden-portal#12:
  | You are working on GitHub issue **cooolinho/trainingsstunden-portal#12**: …
```

Bei einem Fehler endet der Dry Run mit Exit-Code 1 und einer konkreten Meldung, z. B. einem fehlenden Token-Scope.

## 7. Starten

```bash
npm start
```

Symphony läuft im Vordergrund und schreibt seine Logs ins Terminal. Mit `SYMPHONY_PORT=4000` in der `.env` erreichst
du das Dashboard unter <http://127.0.0.1:4000/>.

- **Beenden:** `Strg+C`. Symphony stoppt laufende Agenten und wartet, bis ihre `after_run`-Hooks fertig sind. Ein
  zweites `Strg+C` beendet sofort.
- **Im Hintergrund laufen lassen:** z. B. in `tmux` oder `screen`, oder mit Logdatei:
  `npm start -- --log-file ~/symphony.log`

← [Dokumentation](index.md) · Weiter: [Usage](usage.md)
