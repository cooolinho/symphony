# Symphony

Arbeitet GitHub-Issues selbstständig ab: Für jedes Issue in einer aktiven Spalte deines GitHub Project Boards
startet Symphony eine eigene Claude-Code-Session in einem eigenen Workspace. Am Ende steht ein Pull Request, der auf
dein Review wartet.

## 📖 About

Symphony ist ein dauerhaft laufender Dienst. Er fragt in einem festen Takt ein **GitHub Project Board** ab und
übergibt bereitstehende Issues an **Claude Code**. Pro Issue legt Symphony einen eigenen Ordner an, klont dort das
Repository und lässt den Agenten arbeiten: Branch anlegen, implementieren, testen, pushen, Pull Request öffnen,
Ergebnis im Issue kommentieren. Danach schiebt der Agent die Karte nach **In review**. Ab dort bist du dran: Review,
Merge, Karte nach **Done**.

```
Backlog ──▶ Ready ──▶ In progress ──▶ In review ──▶ Done
   │          │            │               │           │
 ignoriert  Symphony     Agent          Agent ist   Agent gestoppt,
            startet      arbeitet       fertig,     Workspace
            Agent                       wartet auf  gelöscht
                                        dich
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
- **Claude Code als Agent:** Mehrere Turns pro Session, Modell frei wählbar (z. B. `opus`). Riskante Aktionen
  blockiert Claude Codes `auto`-Modus.
- **Modell pro Issue:** Ein Label wie `Model: sonnet` oder `Model: claude-opus-5-5` wählt das Modell für ein Issue.
  `npm run repo-init` legt die Labels `Model: opus`, `Model: sonnet` und `Model: haiku` in deinen Repositories an.
- **Laravel Boost automatisch:** Erkennt Symphony im Workspace eine Laravel-App mit `laravel/boost`, bekommt der
  Agent Boosts Guidelines, Skills und MCP-Server (Doku-Suche, Datenbankschema, Logs), passend zu den installierten
  Paketversionen. Generierte Dateien landen nie im Pull Request.
- **Skills für alle Repositories:** Der Ordner `.claude/` wird als Plugin `symphony` in jede Session geladen. Skills
  der Repositories und von Boost kommen dazu.
- **Tracker-Tools für den Agenten:** Status setzen, kommentieren, Pull Request öffnen. Der GitHub-Token bleibt
  dabei im Symphony-Prozess, der Agent sieht ihn nie.
- **Robust:** Wiederholungen mit exponentiellem Backoff, Erkennung hängender Sessions. Ändert sich das Board während
  ein Agent läuft, wird er gestoppt.
- **Zentral konfigurierbar:** Die `WORKFLOW.md` wird live neu geladen, ohne Neustart. Die `.env` enthält Board,
  Repository, Modell und Token. Eine Instanz kann mehrere Repositories bedienen.
- **Beobachtbar:** Optionales Dashboard mit JSON-API, strukturierte Logs, ein Transkript pro Session, `--dry-run`
  zum Prüfen der Einrichtung.
- **Logs und Kosten pro Repository:** Ein fortlaufendes Log hält fest, wann welches Issue bearbeitet wurde, mit
  Tokens, Modell, geschätzten Kosten und Agentenzeit. Die Kosten berechnet Symphony mit deinen Preisen aus der
  `model-costs.yml`. Eine Logs-Seite im Dashboard zeigt Statistiken, gesamt oder pro Repository.

## 🚀 Getting Started

### Voraussetzungen

| Was | Prüfen mit |
|---|---|
| Linux, WSL2 oder macOS mit **Node.js ≥ 26** und npm | `node --version` |
| **git** mit SSH-Zugriff auf GitHub (Symphony klont per SSH, der Agent pusht per SSH) | `ssh -T git@github.com` |
| **Claude Code**, angemeldet. Alternativ ein `ANTHROPIC_API_KEY` | `claude` starten, ggf. `/login` |
| **GitHub-Token** mit den Scopes `repo` und `project` | siehe Schritt 3 |
| Nur für Laravel-Repositories: **PHP** und **Composer** in den Versionen der Projekte | `php --version`, `composer --version` |

Das Claude Agent SDK bringt seine eigene Claude-Code-CLI mit. Es nutzt dieselbe Anmeldung wie dein installiertes
`claude`.

### 1. Installieren

```bash
cd ~/projects/symphony
npm install
```

### 2. GitHub Project Board einrichten

1. Lege auf GitHub unter **Profil → Projects → New project** ein Projekt mit der Vorlage **Kanban** an. Sie bringt die
   Spalten `Backlog`, `Ready`, `In progress`, `In review` und `Done` mit. Genau diese Namen erwartet die mitgelieferte
   `WORKFLOW.md`.
2. Notiere die **Board-Nummer** aus der URL, z. B. `10` aus `https://github.com/users/cooolinho/projects/10`.
3. Füge Issues hinzu: im Board über **+ Add item** und dann `#` für ein Issue deines Repositories, oder in der
   Seitenleiste eines Issues unter **Projects**. Symphony bearbeitet nur echte Issues, keine Entwürfe und keine
   Pull Requests.
4. Optional: Abhängigkeiten und Sub-Issues anlegen. Symphony startet ein Issue erst, wenn alles erledigt ist, wovon es
   abhängt. Siehe [Abhängigkeiten und Sub-Issues](#abhängigkeiten-und-sub-issues).

> Heißen deine Spalten anders, zum Beispiel `Todo`, `In Progress`, `Human Review` und `Done` (andere Vorlage), passe
> `active_states` und `terminal_states` sowie die Statusnamen im Prompt der `WORKFLOW.md` an. Wichtig ist eine
> Übergabe-Spalte, die weder aktiv noch final ist (hier `In review`). Ohne sie hört der Agent nie auf, siehe
> [Fehlerbehebung](#fehlerbehebung).

### 3. GitHub-Token erstellen

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

### 4. `.env` anlegen

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
SYMPHONY_MAX_CONTINUATIONS=2
SYMPHONY_POLL_INTERVAL_MS=30000
SYMPHONY_CLEANUP_TERMINAL=true
```

| Variable | Bedeutung |
|---|---|
| `GITHUB_PROJECT_NUMBER` | Nummer des Boards. Die ganze Board-URL geht auch. |
| `GITHUB_REPOSITORY` | `owner/name` des Repositories. Mehrere Repositories trennst du mit Kommas. Issues anderer Repositories auf dem Board werden ignoriert. |
| `CLAUDE_MODEL` | Standardmodell für Claude Code: Alias wie `opus` oder `sonnet`, oder eine volle Modell-ID. Leer heißt: Claude-Code-Standard. Ein Label `Model: …` am Issue hat Vorrang, siehe [Modell pro Issue wählen](#modell-pro-issue-wählen). |
| `GITHUB_TOKEN` | Token aus Schritt 3. Er wird aus der Umgebung von Agenten und Hooks entfernt. |
| `GITHUB_PROJECT_OWNER` | *optional:* Eigentümer des Boards, falls nicht der Repository-Eigentümer (z. B. eine Organisation) |
| `SYMPHONY_PORT` | *optional:* Port für Dashboard und API, z. B. `4000` für `http://127.0.0.1:4000/` |
| `ANTHROPIC_API_KEY` | *optional:* Sonst nutzt Claude Code seine bestehende Anmeldung. |
| `SYMPHONY_MAX_CONCURRENT_AGENTS` | *optional:* Wie viele Agenten gleichzeitig laufen. Standard 2, `0` pausiert alle neuen Starts. |
| `SYMPHONY_MAX_TURNS` | *optional:* Turns pro Session, bevor Symphony den Stand neu bewertet. Standard 10. |
| `SYMPHONY_MAX_CONTINUATIONS` | *optional:* Wie viele weitere Sessions ein Issue bekommt, solange seine Karte aktiv bleibt. Danach **pausiert** Symphony das Issue, siehe [Fortsetzungen und Pausieren](#fortsetzungen-und-pausieren). Leer heißt unbegrenzt. |
| `SYMPHONY_POLL_INTERVAL_MS` | *optional:* Wie oft das Board abgefragt wird, in Millisekunden. Standard 30000. |
| `SYMPHONY_CLEANUP_TERMINAL` | *optional:* `true` (Standard) löscht den Workspace, sobald ein Issue in `Done` landet. Vorher läuft der `before_remove`-Hook, z. B. für eine Test-Datenbank. `false` behält die Workspaces. |
| `SYMPHONY_LOG_DIR` | *optional:* Ordner für Repository-Logs und Session-Transkripte. Standard: `~/.local/state/symphony`. Ein relativer Pfad gilt ab dem Symphony-Ordner, z. B. `logs`. |

Die `WORKFLOW.md` liest diese Werte über Verweise wie `$GITHUB_TOKEN` oder `${SYMPHONY_MAX_TURNS:-10}`. Die zweite
Form hat einen Standardwert, falls die Variable fehlt oder leer ist. Variablen, die in deiner Shell bereits gesetzt
sind, haben Vorrang vor der `.env`. Symphony meldet so einen Konflikt beim Start mit dem Variablennamen, nie mit dem
Wert. Nach Änderungen an der `.env` musst du Symphony neu starten.

### 5. Labels anlegen (optional)

Mit Labels wie `Model: sonnet` wählst du pro Issue das Modell, siehe [Modell pro Issue wählen](#modell-pro-issue-wählen).
Das Script `repo-init` legt sie in den Repositories aus `GITHUB_REPOSITORY` an:

```bash
npm run repo-init
```

Es führt dich durch eine Auswahlliste, zeigt vor jeder Änderung, was es anlegen würde, und fragt nach. Mehr dazu unter
[Repositories einrichten (repo-init)](#repositories-einrichten-repo-init).

### 6. Einrichtung prüfen (Dry Run)

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
Active states:   Ready, In progress
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

### 7. Starten

```bash
npm start
```

Symphony läuft im Vordergrund und schreibt seine Logs ins Terminal. Mit `SYMPHONY_PORT=4000` in der `.env` erreichst
du das Dashboard unter <http://127.0.0.1:4000/>.

- **Beenden:** `Strg+C`. Symphony stoppt laufende Agenten und wartet, bis ihre `after_run`-Hooks fertig sind. Ein
  zweites `Strg+C` beendet sofort.
- **Im Hintergrund laufen lassen:** z. B. in `tmux` oder `screen`, oder mit Logdatei:
  `npm start -- --log-file ~/symphony.log`

## 📋 Usage

### Der Ablauf eines Issues

1. Symphony fragt das Board alle 30 Sekunden ab (`polling.interval_ms`). Kandidaten sind Issues in `Ready` oder
   `In progress`. Sie werden nach Priorität sortiert, dann nach Alter.
2. Für das Issue entsteht `~/symphony-workspaces/<owner>_<repo>_<nr>-<hash>`. Der Hook `after_create` klont dort das
   Repository des Issues. Vor jedem Lauf holt `before_run` den neuesten Stand (`git fetch`). Enthält der Klon eine
   Laravel-App mit Laravel Boost, bereitet Symphony Boost vor (siehe [Laravel Boost](#laravel-boost)).
3. Claude Code startet im Workspace und bekommt den Prompt aus der `WORKFLOW.md`. Der Agent:
   - liest `AGENTS.md`, `CLAUDE.md` und `README.md` des Repositories,
   - liest die Kommentare und verknüpften Pull Requests des Issues,
   - setzt das Issue auf `In progress` und kommentiert seinen Plan,
   - arbeitet auf dem Branch `symphony/issue-<nr>`, oder auf einem Branch, den du im Issue verknüpft hast,
   - implementiert, testet, committet, pusht und öffnet einen Pull Request mit `Closes #<nr>`,
   - kommentiert das Ergebnis im Issue und setzt es auf `In review`.
4. Nach jedem Turn prüft Symphony das Issue. Steht es noch in einer aktiven Spalte, bekommt der Agent einen weiteren
   Turn, bis `agent.max_turns` erreicht ist. Danach prüft Symphony nach einer Sekunde erneut und startet bei Bedarf
   eine neue Session. Höchstens `SYMPHONY_MAX_CONTINUATIONS` solcher Sessions, dann wird das Issue pausiert.
5. Du prüfst den Pull Request, mergst ihn und schiebst die Karte nach `Done`. Symphony löscht dann den Workspace.

| Spalte | Was Symphony tut |
|---|---|
| `Backlog` | nichts. Issues hier sind noch nicht freigegeben. |
| `Ready` | startet einen Agenten, sobald ein Platz frei ist |
| `In progress` | ein Agent arbeitet; findet Symphony hier ein Issue ohne Agenten, startet es einen |
| `In review` | stoppt einen laufenden Agenten; der Workspace bleibt für Nacharbeiten erhalten |
| `Done` | stoppt einen laufenden Agenten und löscht den Workspace, spätestens beim nächsten Abfragen |

Willst du Nacharbeiten, kommentiere im Issue und schiebe es zurück nach `Ready`. Der Agent macht im selben Workspace
weiter und liest deine Kommentare.

### Eingreifen während des Betriebs

| Ziel | So geht's |
|---|---|
| Einen Agenten stoppen | Issue nach `Backlog` oder `In review` schieben. Er stoppt beim nächsten Abfragen, spätestens nach 30 s. |
| Abbrechen und aufräumen | Issue nach `Done` schieben |
| Alle neuen Starts pausieren | in der `WORKFLOW.md` `agent.max_concurrent_agents: 0` setzen. Laufende Agenten arbeiten weiter. |
| Prompt oder Einstellungen ändern | `WORKFLOW.md` bearbeiten. Das gilt sofort für neue Sessions, ohne Neustart. |
| Sofort abfragen statt 30 s zu warten | im Dashboard auf **Poll now** klicken, oder `curl -X POST http://127.0.0.1:4000/api/v1/refresh` |

Ist die `WORKFLOW.md` nach einer Änderung fehlerhaft, läuft Symphony mit der letzten gültigen Version weiter. Neue
Agenten startet es dann erst wieder, wenn der Fehler behoben ist. Die Meldung steht im Log und im Dashboard.

### Fehlschläge und Wiederholungen

Scheitert ein Lauf, versucht Symphony es erneut. Gründe können ein fehlgeschlagener Hook sein, ein Fehler des
Agenten, eine Zeitüberschreitung oder eine hängende Session (10 Minuten ohne Aktivität). Die Wartezeit verdoppelt
sich jedes Mal: 10 s, 20 s, 40 s und so weiter, höchstens 10 Minuten (`agent.max_retry_backoff_ms`). Die
Warteschlange mit Grund und nächstem Termin siehst du im Dashboard. Beim nächsten Versuch weiß der Agent über
`attempt`, dass es schon Vorarbeit im Workspace gibt.

### Abhängigkeiten und Sub-Issues

Ein Issue wartet, solange etwas offen ist, wovon es abhängt. Es bleibt dabei in `Ready`, und Symphony startet es
automatisch, sobald alles erledigt ist. Drei Arten von Abhängigkeiten zählen:

| Art | So legst du sie an |
|---|---|
| Relationship | In der Seitenleiste des Issues unter **Relationships → Blocked by** |
| Text im Issue | In der Beschreibung, z. B. `blocked by #12`, `blocked #12` oder `Blocked by: #12, #13`. `#N` meint dasselbe Repository, andere gehen als `owner/repo#N`. |
| Sub-Issues | In der Seitenleiste unter **Sub-issues**. Das Parent-Issue wartet, bis alle Sub-Issues geschlossen sind. |

Erledigt ist eine Abhängigkeit, wenn das Issue **geschlossen** ist; bei einem referenzierten Pull Request, wenn er
gemergt oder geschlossen ist. Agenten schließen keine Issues selbst. Eine Abhängigkeit löst sich also, sobald du den
zugehörigen Pull Request mit `Closes #N` mergst. So baut das nächste Issue auf gemergtem Code auf. Referenzen auf nicht
existierende Issues werden ignoriert. Warum ein Issue wartet, zeigt `npm run dry-run`. Der Agent sieht Parent,
Sub-Issues und Abhängigkeiten im Prompt.

### Fortsetzungen und Pausieren

Endet eine Session regulär, das Issue steht aber noch in `Ready` oder `In progress`, startet Symphony nach einer
Sekunde eine **Fortsetzungs-Session**. Der Agent war dann nicht fertig, etwa weil `max_turns` erreicht war. Damit ein
Issue nicht endlos Sessions verbraucht, begrenzt `SYMPHONY_MAX_CONTINUATIONS` diese Fortsetzungen. Mit dem Wert `2`
bekommt ein Issue höchstens drei Sessions: die erste und zwei Fortsetzungen. Ist es danach immer noch aktiv, wird es
**pausiert**:

- Es bleibt für Symphony reserviert, aber kein Agent startet mehr dafür. Im Log erscheint die Warnung
  `issue paused`, und das Dashboard zeigt es unter **Paused**.
- Es geht von selbst weiter, sobald sich auf dem Board etwas daran ändert: ein Kommentar von dir (z. B. ein Hinweis
  für den Agenten), ein geändertes Label, eine bearbeitete Beschreibung oder eine andere Spalte. Dann startet eine
  frische Session, die deinen Kommentar liest.
- Verschiebst du die Karte in eine nicht aktive Spalte, wird die Pause aufgehoben, ohne dass etwas startet.
- Erhöhst du das Limit in der `.env` und startest Symphony neu, ist die Pause ebenfalls aufgehoben.

Fehlgeschlagene Läufe zählen hier nicht mit. Für sie gelten die Wiederholungen mit Wartezeit von oben.

### Modell pro Issue wählen

Jede Session nutzt das Modell aus `CLAUDE_MODEL`, außer das Issue trägt ein Label `Model: …`. Dann gilt für dieses
Issue das Modell aus dem Label:

| Label | Modell für Claude Code |
|---|---|
| `Model: opus`, `Model: claude-opus` | `opus`, immer das neueste Opus-Modell |
| `Model: claude-opus-5-5` | `claude-opus-5-5` |
| `Model: sonnet`, `Model: claude-sonnet` | `sonnet`, immer das neueste Sonnet-Modell |
| `Model: sonnet-5-5`, `Model: claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `Model: haiku` | `haiku`, immer das neueste Haiku-Modell |

- `repo-init` legt nur `Model: opus`, `Model: sonnet` und `Model: haiku` an. Die übrigen Labels aus der Tabelle legst
  du bei Bedarf selbst in GitHub an.
- Groß- und Kleinschreibung spielen keine Rolle. `claude-` davor ist optional, bei Werten mit Version ergänzt Symphony
  es. So gehen auch Modelle, für die es kein Standard-Label gibt, z. B. `Model: claude-opus-4-8`.
- Ohne Model-Label gilt `CLAUDE_MODEL`. Das gilt auch bei einem unbekannten Wert (z. B. `Model: gpt-4`) oder bei
  mehreren Labels mit verschiedenen Modellen. Symphony schreibt dann die Warnung `model label ignored` ins Log und in
  den Dry Run.
- Das Modell gilt für eine ganze Session. Änderst du das Label, während ein Agent läuft, gilt das neue Modell ab der
  nächsten Session, also der nächsten Fortsetzung oder Wiederholung. Ein pausiertes Issue läuft nach einer
  Label-Änderung weiter, gleich mit dem neuen Modell. So versuchst du ein festgefahrenes Issue z. B. mit `Model: opus`
  erneut.
- Kontrolle: `npm run dry-run` zeigt pro Issue `↳ model … (label "…")`. Beim Start steht das Modell in der Logzeile
  `dispatching issue` (`model=…`, bei einem Label auch `model_label=…`) und im Log des Repositorys bei `run_started`.
  Das Dashboard zeigt in der Spalte *Model* das Modell, das Claude Code tatsächlich nutzt.
- Im Prompt fehlen die Model-Labels in der Label-Liste des Agenten. Für seine Arbeit spielen sie keine Rolle.
- Nicht verwechseln mit `claude.fallback_model` in der `WORKFLOW.md`: Das ist ein Ausweichmodell, falls das Modell
  überlastet ist. Wählt ein Label genau dieses Modell, lässt Symphony das Ausweichmodell für diese Session weg.

### Repositories einrichten (repo-init)

`repo-init` richtet die Repositories aus `GITHUB_REPOSITORY` interaktiv ein. Es gibt zwei Schritte: die
Standard-Labels für die Modellwahl und ein Issue, das Laravel Boost einführt. Weitere Schritte kommen als Einträge in
derselben Auswahlliste dazu.

```bash
npm run repo-init                            # oder ./repo-init.ts
npm run repo-init -- --env-file .env.website # andere Env-Datei, wie bei npm start
```

1. Bei mehreren Repositories wählst du, welche eingerichtet werden. Enter heißt: alle.
2. In der Auswahlliste wählst du den Schritt, z. B. `1) Standard labels`. `0` beendet das Script.
3. **Standard labels:** Das Script zeigt pro Repository, welche Labels es anlegen (`+`) oder ändern (`~`) würde,
   und fragt vor jeder Änderung nach. Bestehende Labels mit anderer Farbe oder Beschreibung oder archivierte Labels
   aktualisiert es nur, wenn du zustimmst. Es löscht nichts. Ein zweiter Lauf meldet
   `All standard labels are up to date.`
4. **Laravel Boost:** Das Script sucht auf dem Standard-Branch Laravel-Apps (Root oder eine Ebene tiefer). Pro
   Repository meldet es `– no Laravel app`, `✓ Laravel Boost installed`, `= open issue #N` oder
   `+ create issue "Laravel Boost einrichten"`. Nach deiner Bestätigung legt es das Issue an: Es beschreibt
   `composer require laravel/boost --dev`, `boost:install`, die `.gitignore`-Einträge und den Ordner `.ai/`. Zieh das
   Issue auf das Board, dann führt ein Agent Boost per Pull Request ein.

Das Script nutzt `GITHUB_REPOSITORY` und `GITHUB_TOKEN` aus der `.env`. Ein klassischer Token braucht den Scope `repo`,
den der Symphony-Token schon hat. Ein Fine-grained Token braucht *Issues: Read and write* und *Contents: Read* für
die Repositories. Die Standard-Labels stehen in `src/repo-init/labels.ts`, der Boost-Schritt in
`src/repo-init/laravel-boost.ts`, neue Einrichtungsschritte kommen in `src/repo-init/tasks.ts` dazu.

### Orchestrierung testen (E2E)

`npm run e2e` prüft die Orchestrierung auf einem echten Board. Das Script legt neun Test-Issues mit Abhängigkeiten
an, alle mit `Model: sonnet`. Die Agenten kommentieren nur. Dann startet es eine eigene Symphony-Instanz und spielt
den Reviewer: Issues in `In review` setzt es nach 60 s auf `Done` und schließt sie. Am Ende prüft es, dass nie mehr
als `max_concurrent_agents` Agenten gleichzeitig liefen und dass kein Issue vor dem Schließen seiner Abhängigkeiten
gestartet wurde.

```bash
npm run e2e                                  # nutzt WORKFLOW.md und .env, wie npm start
node scripts/e2e/verify.ts logs/e2e/<zeit>   # einen Lauf später erneut prüfen
```

Nimm dafür ein eigenes Test-Repository mit eigenem Board: Die Issues sind echt, und jeder Lauf kostet Claude-Nutzung
(etwa 0,50 USD). Das Script bricht ab, wenn auf dem Board schon Issues in aktiven Spalten stehen. Szenario,
Optionen und Prüfungen beschreibt [docs/e2e.md](docs/e2e.md).

### Dashboard und API

Das Dashboard läuft nur, wenn `SYMPHONY_PORT` gesetzt ist oder du `npm start -- --port 4000` aufrufst. Es lauscht nur
auf `127.0.0.1`. Es zeigt laufende Agenten mit Spalte, Phase, Modell, Turns, letzter Aktivität, Tokens und geschätzten
Kosten, außerdem die Wiederholungs-Warteschlange und Probleme wie Konfigurations- oder GitHub-Fehler. Der Button
**Logs** im Header öffnet die [Logs-Seite](#logs-und-statistiken).

| Endpunkt | Inhalt |
|---|---|
| `GET /` | Dashboard |
| `GET /logs` | Logs-Seite mit Statistiken, gesamt oder mit `?repo=owner/name` für ein Repository |
| `GET /api/v1/history` | dieselben Statistiken als JSON, optional mit `?repo=owner/name` |
| `GET /api/v1/history/raw?repo=owner/name` | die `.log`-Datei eines Repositorys als Text |
| `GET /api/v1/state` | Gesamtzustand als JSON: laufende Agenten, Warteschlange, Summen, Gesundheit |
| `GET /api/v1/<identifier>` | Details zu einem Issue: Workspace, Versuche, letzte Ereignisse, letzter Fehler |
| `POST /api/v1/refresh` | sofort abfragen und abgleichen |

```bash
curl -s http://127.0.0.1:4000/api/v1/state
curl -s http://127.0.0.1:4000/api/v1/cooolinho%2Ftrainingsstunden-portal%2312   # / als %2F, # als %23
curl -s -X POST http://127.0.0.1:4000/api/v1/refresh
```

### Logs, Transkripte und Workspaces

| Was | Wo |
|---|---|
| Laufende Logs (`key=value`) | Terminal (stderr). Zusätzlich in eine Datei mit `--log-file <pfad>`, ausführlicher mit `--log-level debug`. |
| Log pro Repository: was wann bearbeitet wurde, mit Tokens, Modell, Kosten und Agentenzeit | `~/.local/state/symphony/repositories/<owner>_<repo>.log`, siehe [Logs und Statistiken](#logs-und-statistiken) |
| Transkript jeder Session (alle Agenten-Nachrichten als JSON-Zeilen) | `~/.local/state/symphony/sessions/<workspace>/<zeit>.jsonl`. Einen anderen Ort wählst du mit `--log-dir <ordner>`. |
| Claude-Code-Session ansehen | im Workspace `claude --resume <thread-id>`. Die ID steht im Log als `thread_id` und in der API (`/api/v1/<identifier>`). |
| Workspaces | `~/symphony-workspaces/`. Sie werden bei `Done` gelöscht; andere kannst du gefahrlos von Hand löschen, wenn kein Agent darin läuft. |

### Logs und Statistiken

Für jedes Repository schreibt Symphony ein fortlaufendes Log, z. B.
`~/.local/state/symphony/repositories/cooolinho_trainingsstunden-portal.log`. Den Ordner änderst du mit
`SYMPHONY_LOG_DIR` in der `.env` oder mit `--log-dir`. Jede Zeile ist ein Ereignis im `key=value`-Format:

```
ts=2026-10-04T09:16:19.000Z event=run_started repo=cooolinho/trainingsstunden-portal issue=cooolinho/trainingsstunden-portal#5 run=8f3c2a1b9d0e title="Symphony-Testkette 3/3: …" state=Ready attempt=null model=opus
ts=2026-10-04T09:17:00.000Z event=run_finished repo=cooolinho/trainingsstunden-portal issue=cooolinho/trainingsstunden-portal#5 run=8f3c2a1b9d0e … outcome=handed_off state="In review" turns=1 model=claude-opus-5-5 total_tokens=153200 cost_usd=0.1491 agent_seconds=41 repo_runs=4 repo_tokens=556200 repo_cost_usd=0.5262 repo_agent_seconds=246
ts=2026-10-04T09:17:00.000Z event=model_usage repo=cooolinho/trainingsstunden-portal issue=cooolinho/trainingsstunden-portal#5 run=8f3c2a1b9d0e model=claude-opus-5-5 price=opus input_tokens=2800 output_tokens=1680 cache_read_tokens=123200 cache_write_tokens=12320 total_tokens=140000 cost_usd=0.1361
```

| Ereignis | Bedeutung |
|---|---|
| `run_started` | Ein Agent beginnt mit einem Issue: Zeitpunkt, Issue, Titel, Spalte, Versuch und gewünschtes Modell (aus dem Label `Model: …`, sonst `CLAUDE_MODEL`). |
| `run_finished` | Ein Lauf endet. Erfasst werden das Ergebnis (`handed_off` = übergeben, `continuing` = noch aktiv, `failed`, `stopped`, `stalled`, `shutdown`) und die Spalte danach. Dazu kommen Turns, das meistgenutzte Modell, Tokens (Input, Output, Cache), geschätzte Kosten und Agentenzeit. Die Felder `repo_*` sind die laufenden Summen des Repositorys. |
| `model_usage` | Tokens und Kosten eines Laufs pro Modell. Arbeitet Claude Code intern mit einem zweiten Modell, gibt es eine zweite Zeile. |
| `issue_paused` | Ein Issue wurde nach seinen Fortsetzungs-Sessions pausiert. |
| `workspace_removed` | Der Workspace eines Issues in `Done` wurde gelöscht. |

Die **Logs-Seite** (`/logs`, Button *Logs* im Dashboard) wertet diese Dateien aus. Oben wählst du *Alle
Repositories* oder ein einzelnes. Die Seite zeigt dann:

- Kennzahlen: geschätzte Kosten, Tokens, Agentenzeit, Läufe und Issues,
- Tabellen nach **Modell** (mit Kostenanteil), nach **Repository**, nach **Issue** (Läufe, letztes Ergebnis, erster
  Start, letztes Ende) und nach **Tag**,
- die letzten Log-Einträge und bei einem einzelnen Repository einen Link auf die rohe `.log`-Datei.

### Kosten schätzen mit `model-costs.yml`

Die Kosten berechnet Symphony aus den Tokens mit den Preisen in der `model-costs.yml` im Symphony-Ordner. Die Preise
gelten in USD pro Million Tokens. Änderungen wirken ohne Neustart. Die Logs-Seite rechnet auch ältere Einträge mit
den aktuellen Preisen neu.

```yaml
default:            # gilt für jedes Modell ohne passenden Eintrag
  input: 5.00
  output: 25.00

opus:               # gilt für jede Modell-ID, die "opus" enthält, z. B. claude-opus-5-5
  input: 4.00
  output: 20.00
  cache_read: 0.20  # optional; Standard: 10 % des Input-Preises (cache_write: 125 %)

claude-opus-4-8:    # eine exakte Modell-ID hat Vorrang vor "opus"
  input: 5.00
  output: 25.00
```

Welche Zeile für ein Modell gilt, steht auf der Logs-Seite in der Spalte *Price entry*. Ist die Datei fehlerhaft,
rechnet Symphony mit den letzten gültigen Preisen weiter und zeigt den Fehler im Dashboard. Fehlt sie ganz, gilt für
alle Modelle ein eingebauter Standard von 5 $ / 25 $. Claude Codes eigene Schätzung steht zum Vergleich als
`claude_estimate_usd` im Log.

### Mehrere Repositories

- **Ein Board für mehrere Repositories:** Trage alle in die `.env` ein, z. B.
  `GITHUB_REPOSITORY=cooolinho/trainingsstunden-portal,cooolinho/website`. Jedes Issue wird in einen Klon seines
  eigenen Repositories bearbeitet. Der Hook nutzt dafür `$SYMPHONY_ISSUE_REPOSITORY`.
- **Ein Board pro Repository:** Lege pro Board eine eigene Env-Datei an und starte je eine Instanz mit eigenem Port:

  ```bash
  cp .env .env.website                   # dann GITHUB_PROJECT_NUMBER, GITHUB_REPOSITORY und SYMPHONY_PORT anpassen
  npm start                              # Instanz 1 mit .env
  npm start -- --env-file .env.website   # Instanz 2, z. B. in einem zweiten Terminal
  ```

  Die Instanzen teilen sich `~/symphony-workspaces`. Ihre Ordnernamen kollidieren nicht, weil sie das Repository
  enthalten.

### Konfiguration anpassen

Die häufigsten Stellschrauben in der `WORKFLOW.md`. Alle Optionen beschreibt
[docs/configuration.md](docs/configuration.md).

| Einstellung | Wirkung |
|---|---|
| `agent.max_concurrent_agents` | wie viele Agenten gleichzeitig laufen (Standard hier: 2) |
| `agent.max_concurrent_agents_by_state` | Grenze pro Spalte, z. B. `{ "In progress": 1 }` |
| `agent.max_turns` | Turns pro Session, bevor Symphony den Stand neu bewertet |
| `agent.max_continuations` | Fortsetzungs-Sessions pro Issue, danach Pause |
| `workspace.cleanup_terminal` | Workspaces bei `Done` löschen (Standard) oder behalten |
| `claude.max_budget_usd` | Kostenobergrenze pro Session |
| `claude.effort` | Denkaufwand: `low` … `max` |
| `claude.allowed_tools` | Aktionen, die immer erlaubt sind, z. B. `"Bash(npm test:*)"` |
| `claude.plugins`, `claude.skills` | Plugin-Ordner für alle Sessions (Standard: `./.claude`) und welche Skills aktiv sind (`all`) |
| `laravel.*` | Laravel Boost: `boost: auto` oder `off`, PHP- und Composer-Befehl, Umgebung (`APP_ENV: local`) |
| `tracker.required_labels` | nur Issues mit diesen Labels bearbeiten, z. B. `[symphony]` |
| `hooks.*` | Shell-Skripte rund um jeden Lauf, z. B. Abhängigkeiten installieren |
| Text unterhalb der Front Matter | der Prompt, ein Liquid-Template mit `issue` und `attempt` |

### Sicherheit

- **Berechtigungen:** Claude Code läuft im Modus `auto`. Ein Klassifikator erlaubt normale Entwicklungsarbeit und
  blockiert Riskantes. Fragt Claude Code trotzdem nach, antwortet Symphony mit *nein*
  (`on_permission_request: deny`), denn es schaut niemand zu. `git push` ist ausdrücklich erlaubt.
- **Token:** Der GitHub-Token wird aus der Umgebung des Agenten und der Hooks entfernt. Status, Kommentare und Pull
  Requests laufen über Tools, die Symphony selbst ausführt.
- **Grenzen:** Der Agent läuft als dein Linux-Benutzer. Er könnte grundsätzlich Dateien lesen, die du lesen kannst,
  etwa die `.env`, sofern Klassifikator oder Sandbox es nicht verhindern. Issue-Texte sind fremde Eingaben. Bearbeite
  nur Boards, deren Issues du vertraust. Für mehr Isolation: `claude.sandbox` aktivieren oder Symphony unter einem
  eigenen Benutzer, in einem Container oder einer VM betreiben. Details: [docs/agent-claude.md](docs/agent-claude.md).

### Kosten

Jede Session startet mit rund 30.000 Tokens Kontext (System-Prompt und Tool-Beschreibungen von Claude Code). Ein
minimaler Test-Turn mit `opus` kostete etwa 0,15 $. Echte Issues kosten je nach Umfang deutlich mehr. Das Dashboard
zeigt die geschätzten Kosten pro Agent und seit dem Start. Die Logs-Seite zeigt sie pro Repository, Modell, Issue und
Tag. Geschätzt wird mit der [`model-costs.yml`](#kosten-schätzen-mit-model-costsyml). Zum Begrenzen eignen sich:

- `claude.max_budget_usd` pro Session,
- ein günstigeres Modell für einfache Issues per Label, z. B. `Model: sonnet` oder `Model: haiku`,
- wenige parallele Agenten,
- `tracker.required_labels`, damit nur ausdrücklich markierte Issues bearbeitet werden.

### Laravel Boost

[Laravel Boost](https://laravel.com/docs/boost) gibt KI-Agenten Laravel-Wissen passend zu den installierten Paketen:
**Guidelines** (immer geladen), **Skills** (bei Bedarf geladen, z. B. `pest-testing`, `livewire-development`) und
einen **MCP-Server** mit Doku-Suche, Datenbankschema, Logs und Fehlern. Symphony nutzt Boost automatisch:

1. Nach dem `before_run`-Hook sucht Symphony im Workspace Laravel-Apps: im Root oder eine Ebene tiefer, z. B.
   `laravel/` im trainingsstunden-portal.
2. Steht `laravel/boost` in der `composer.json`, installiert Symphony bei Bedarf die Abhängigkeiten
   (`composer install`) und erzeugt Boosts Guidelines und Skills für Claude Code (`boost:install`).
3. Die erzeugten Dateien trägt Symphony in `.git/info/exclude` ein. Versionierte Dateien, die Boost verändert hat,
   setzt es zurück. So landet nichts davon im Pull Request.
4. Die Session bekommt den MCP-Server `laravel-boost`, die Boost-Skills und Boosts Guidelines im System-Prompt.
5. Neu erzeugt wird nur, wenn sich `composer.lock`, `.ai/` oder die Boost-Version ändern.

Damit Artisan und Boost nie eine fremde Datenbank erreichen, legt `hooks/laravel-env.sh` im `after_create`-Hook für jede
Laravel-App eine eigene `.env` mit eigener SQLite-Datenbank an (`database/symphony.sqlite`, `CACHE_STORE=file`,
`BOOST_BROWSER_LOGS_WATCHER=false` u. a.). Eine vorhandene `.env` bleibt unangetastet, `.env` und die Datenbank landen in
`.git/info/exclude`, falls die App sie nicht selbst ignoriert:

```yaml
after_create: |
  git clone --quiet "git@github.com:${SYMPHONY_ISSUE_REPOSITORY}.git" .
  bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"
```

Fehlt Boost in einem Laravel-Repository, legt `npm run repo-init` → *Laravel Boost* ein Issue an, das Boost per Pull
Request einführt. Klappt etwas nicht (kein PHP, `composer install` scheitert), läuft die Session ohne Boost weiter.
Die Warnung steht im Log. `npm run dry-run` zeigt, ob `php` und `composer` laufen.

Voraussetzungen und Grenzen:

- **PHP und Composer auf dem Host**, in den Versionen, die die Projekte verlangen. Eigene Pfade:
  `SYMPHONY_PHP=/usr/bin/php8.4` in der `.env`. Soll PHP später in einem Container laufen, zeigt `laravel.php` auf ein
  Wrapper-Script. Es bekommt den absoluten `artisan`-Pfad als erstes Argument und `SYMPHONY_WORKSPACE` in der
  Umgebung.
- **`APP_ENV=local`:** Boost läuft nur lokal. Symphony setzt die Variable für Composer, `artisan`, den MCP-Server und
  den Agenten, weil ein frischer Klon keine `.env` hat. Weitere Variablen kommen unter `laravel.env` dazu, z. B.
  `DB_CONNECTION: sqlite`, damit Boosts Datenbank-Tools nicht deine Entwicklungsdatenbank lesen.
- **Committete Boost-Dateien:** Liegt `boost.json` im Repository, verwaltet das Repository Boost selbst. Symphony
  erzeugt dann nichts und nutzt die committeten Dateien.
- **Sail:** Erkennt Boost Laravel Sail, verweisen seine Guidelines auf `vendor/bin/sail`. Symphony warnt dann, weil es
  PHP auf dem Host ausführt.

### Skills: wo gehören sie hin?

Faustregel: Wissen gehört dorthin, wo es versioniert wird und wo es gilt.

| Wissen | Ort | Warum |
|---|---|---|
| Framework-Wissen (Laravel, Livewire, Pest, Inertia …) | **Laravel Boost** im jeweiligen Repository, von Symphony erzeugt | passt zu den Versionen in `composer.lock`; Kopien in Symphony würden veralten |
| Domäne und Projekt („Rechnungen erstellen“, Mandanten-Scoping) | **Repository:** `.ai/skills/` und `.ai/guidelines/` (Laravel), sonst `.claude/skills/` | wird mit dem Code versioniert und im Pull Request geprüft; hilft auch dir lokal |
| Projektregeln und Fallen | **Repository:** `.ai/rules/`, über Boosts Tool `record-rule` oder den Skill `infer-conventions` | wird nach Dateipfad geladen und gilt für alle |
| Arbeitsweise über alle Repositories (PR-Stil, Commits, Prüfen ohne UI, Übergabe ans Board) | **Symphony:** `.claude/skills/` | gilt nur für Symphony-Agenten, in jedem Repository gleich |
| Persönliche Vorlieben | `~/.claude/` | lädt Symphony bewusst nicht |

Alles ins Symphony-Repository zu legen, wäre bequem, hat aber Nachteile. Diese Skills sähen nur Symphony-Agenten,
nicht du lokal. Sie hingen nicht an der Code-Version des Repositories. Und Boost-Skills lassen sich nur im Repository
überschreiben: Ein gleichnamiger Skill in `.ai/skills/` ersetzt den von Boost.

In Laravel-Repositories gehören eigene Skills nach `.ai/skills/<name>/SKILL.md`, nicht nach `.claude/skills/`. Boost
überschreibt `.claude/skills` beim Erzeugen, und `.ai/` funktioniert auch mit anderen Agenten (Cursor, Codex …).

Symphonys `.claude/` hat die Ordner `skills/`, `agents/`, `commands/` und `hooks/` und wird über
`claude.plugins: [./.claude]` geladen. Seine Skills heißen im Agenten `symphony:<name>`. Regeln für gute Skills stehen
in [.claude/README.md](.claude/README.md).

### Repositories mit Docker-Setup (z. B. trainingsstunden-portal)

Im Portal laufen PHP- und Artisan-Befehle laut `AGENTS.md` per `docker exec … portal`. Dieser Container bindet aber
deinen Haupt-Checkout ein (`~/projects/trainingsstunden-portal/laravel`), nicht den Workspace des Agenten. Tests dort
würden den falschen Code prüfen, und Migrationen würden deine Entwicklungsdatenbank verändern. Der Prompt weist den
Agenten deshalb an, keine fremden Container zu nutzen und nicht ausführbare Prüfungen im Ergebnis zu nennen.

Damit der Agent PHP-Tests selbst ausführen kann, braucht jeder Workspace einen eigenen Docker-Stack. Das lässt sich
über die Hooks einrichten:

- `after_create` erzeugt im Klon eine `.env` mit eigenem `APP_CONTAINER_NAME` und eigenen Ports und startet
  `docker compose -p <workspace-key> up -d`.
- `before_remove` räumt mit `docker compose … down -v` auf.

Das ist bewusst noch nicht vorkonfiguriert, weil es Ressourcen und Ports pro Issue kostet. Am besten fängst du dafür
mit `max_concurrent_agents: 1` an. Laravel Boost läuft bis dahin mit PHP auf dem Host (siehe [Laravel Boost](#laravel-boost)).
Mit einem Stack pro Workspace kann `laravel.php` auf ein Wrapper-Script zeigen, das PHP in diesem Container ausführt.

### Fehlerbehebung

| Symptom | Ursache und Lösung |
|---|---|
| `GitHub token lacks a required scope` | Dem Token fehlt `project`. Lösung: `gh auth refresh -s project`, oder einen klassischen Token mit `repo` und `project` erstellen. |
| `GitHub rejected the token (HTTP 401)` | Token falsch oder abgelaufen. `GITHUB_TOKEN` in der `.env` prüfen. |
| `Candidates in active states: 0` | Das Board ist leer, kein Issue steht in `Ready` oder `In progress`, die Issues stammen aus einem anderen Repository als `GITHUB_REPOSITORY`, oder die Spaltennamen passen nicht zu `active_states`. |
| `↳ blocked by …` oder `↳ waiting for sub-issues …` im Dry Run | Das Issue wartet auf eine Abhängigkeit oder ein Sub-Issue. Es startet von selbst, sobald diese geschlossen sind, also meist nach dem Merge ihres Pull Requests. |
| `↳ issue is closed` | Geschlossene Issues werden nicht bearbeitet. |
| `project field "Status" is missing` | Das Board hat kein Single-Select-Feld `Status`. Den Namen des Feldes unter `tracker.provider.status_field` eintragen. |
| `after_create hook exited with code 128 … Permission denied (publickey)` | SSH-Zugriff auf GitHub fehlt. `ssh -T git@github.com` prüfen. |
| Ein Agent fängt immer wieder von vorn an | Das Issue verlässt die aktiven Spalten nie, etwa weil die Übergabe-Spalte fehlt oder `set_status` scheitert (Warnung `agent tracker_tool` mit `set_status failed` im Log). Erst pausieren (`max_concurrent_agents: 0`), dann die Spalten bzw. den Prompt korrigieren. |
| Warnung `agent agent_error` (z. B. `authentication_failed`) oder `startup_failed` | Claude Code ist nicht angemeldet bzw. das Konto hat ein Problem. Einmal `claude` starten und `/login` ausführen, oder `ANTHROPIC_API_KEY` setzen. |
| `env file values ignored because the shell environment already sets them` | Die Variable ist auch in der Shell gesetzt, und die Shell gewinnt. `unset GITHUB_TOKEN` oder den Wert dort anpassen. |
| `dispatch validation failed` | Ein Fehler in der `WORKFLOW.md` oder `.env`. Die genaue Meldung steht im Log bzw. im Dashboard. |
| Warnung `issue paused: still active after its continuation sessions` | Der Agent hat das Issue nach `SYMPHONY_MAX_CONTINUATIONS` Fortsetzungen nicht abgeschlossen. Lies den letzten Kommentar und das Transkript, dann schreib einen Hinweis ins Issue (das setzt es fort) oder verschieb die Karte. |
| Warnung `model label ignored` | Ein Model-Label ist unbekannt (Tippfehler), oder das Issue hat mehrere Model-Labels mit verschiedenen Modellen. Symphony nutzt dann `CLAUDE_MODEL`. Label korrigieren, `npm run dry-run` zeigt das Ergebnis. |
| Session scheitert gleich zu Beginn mit einem Modellfehler | Das Label nennt eine Version, die es nicht gibt, z. B. `Model: claude-opus-9-9`. Symphony wiederholt den Lauf mit Wartezeit. Label korrigieren. |
| `repo-init` meldet `HTTP 404` oder `HTTP 403` | Das Repository in `GITHUB_REPOSITORY` ist falsch geschrieben, oder der Token darf keine Labels oder Issues anlegen bzw. keine Dateien lesen. Klassischer Token: Scope `repo`, Fine-grained Token: *Issues: Read and write* und *Contents: Read*. |
| Warnung `Laravel Boost skipped: composer install failed` | PHP- oder Erweiterungsversion passt nicht zu `composer.lock`, oder Composer erreicht Packagist nicht. Die Ausgabe steht im Log. Passendes PHP installieren und `SYMPHONY_PHP` setzen. |
| Warnung `Laravel Boost skipped: boost:install failed` mit `Command "boost:install" is not defined` | Boost ist nicht aktiv, meist weil `APP_ENV` nicht `local` ist. `laravel.env` prüfen; `BOOST_ENABLED=false` in einer committeten Konfiguration schaltet Boost ganz ab. |
| Warnung `an MCP server Symphony added is not connected` | `php artisan boost:mcp` startet nicht. Im Workspace `APP_ENV=local php artisan boost:mcp` von Hand ausführen und die Fehlermeldung lesen. |
| Dry Run: `php (not found)` | PHP ist nicht installiert oder nicht im `PATH`. Laravel-Workspaces laufen dann ohne Boost. `SYMPHONY_PHP` auf den Pfad setzen. |
| `candidate fetch failed … timed out` oder `HTTP 503` | GitHubs GraphQL-API ist kurzzeitig gestört. Lesende Abfragen wiederholt Symphony automatisch, sonst einfach den nächsten Tick abwarten. Laufende Agenten sind nicht betroffen. |

## 📁 Project Structure

```
symphony/
├── WORKFLOW.md                 # Prompt und Einstellungen (wird live neu geladen)
├── .claude/                    # Toolbox für alle Sessions, geladen als Plugin "symphony" (skills, agents, commands, hooks)
├── .github/workflows/          # CI (npm run check) und automatisches Mergen der Agenten-Pull-Requests
├── model-costs.yml             # Modellpreise für die Kostenschätzung (wird live neu geladen)
├── .env.example                # Vorlage für .env (Board, Repository, Modell, Token, Grenzen)
├── repo-init.ts                # interaktive Einrichtung der Repositories (Model-Labels, Laravel-Boost-Issue)
├── scripts/e2e/                # End-to-End-Test der Orchestrierung auf einem echten Board (npm run e2e)
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
│   ├── http/                   # Dashboard, Logs-Seite und JSON-API
│   ├── repo-init/              # repo-init: Auswahlliste, GitHub-REST-Client, Standard-Labels, Boost-Issue
│   └── util/                   # Hilfsfunktionen (.env, Pfade, Fehler, …)
├── test/                       # Tests mit node:test
└── docs/                       # Referenzdokumentation
```

## 📚 Documentation

- [docs/configuration.md](docs/configuration.md): alle Optionen der `WORKFLOW.md`, `$VARIABLE`-Verweise, Hooks und Prompt-Variablen
- [docs/adapters/github-project.md](docs/adapters/github-project.md): GitHub-Projects-Adapter, also Einstellungen, Normalisierung, Agenten-Tools und Fehler
- [docs/agent-claude.md](docs/agent-claude.md): Ablauf der Claude-Code-Sessions, Berechtigungen, Skills und Plugins, Laravel Boost, Zeitlimits und Kostenzählung
- [docs/conformance.md](docs/conformance.md): Abweichungen von der Spezifikation und eigene Festlegungen
- [docs/e2e.md](docs/e2e.md): End-to-End-Test der Orchestrierung, also Szenario, Ablauf, Prüfungen und Run-Verzeichnis

Für die Entwicklung:

```bash
npm test            # Tests
npm run typecheck   # TypeScript-Prüfung
npm run check       # beides
npm run e2e         # End-to-End-Test auf dem Test-Board (legt echte Issues an)
```

Die CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) führt `npm run check` mit Node 26 für jeden Pull Request
und jeden Push auf `main` aus. Ist sie für einen Pull Request der Symphony-Agenten (Branch `symphony/*`) grün, mergt
[.github/workflows/automerge.yml](.github/workflows/automerge.yml) ihn per Squash und löscht den Branch. Das schließt
das Issue (`Closes #…`), und Symphony startet die Issues, die davon abhängen. Der Auto-Merge läuft immer in der
Fassung von `main`: Ein Pull Request kann die Regeln für seinen eigenen Merge nicht ändern.

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
