# Usage

## Der Ablauf eines Issues

Die mitgelieferte `WORKFLOW.md` arbeitet mit zwei **Rollen**: Ein *Developer* setzt das Issue um, ein *Reviewer*
prüft es, ohne etwas zu ändern. Welche Rolle läuft, entscheidet die Spalte. Zwischen den Rollen stehen
**Checks** (`checks/laravel.sh`: sauberer und gepushter Branch, Lint, statische Analyse, Tests), die Symphony selbst
ausführt, bevor eine Karte nach `Agent review` oder `In review` darf. In Repositories ohne Laravel-App bestehen die
Checks sofort (Exit 0).

1. Symphony fragt das Board alle 30 Sekunden ab (`polling.interval_ms`). Kandidaten sind Issues in `Ready`,
   `In progress` und `Agent review`. Sie werden nach Priorität sortiert, dann nach Alter.
2. Für das Issue entsteht `~/symphony-workspaces/<owner>_<repo>_<nr>-<hash>`. Der Hook `after_create` klont dort das
   Repository des Issues und richtet mit `hooks/laravel-env.sh` für jede Laravel-App eine eigene `.env` mit
   SQLite-Datenbank ein. Vor jedem Lauf holt `before_run` den neuesten Stand (`git fetch`). Enthält der Klon eine
   Laravel-App mit Laravel Boost, bereitet Symphony Boost vor (siehe [Laravel Boost](#laravel-boost)).
3. **Developer** (`Ready`, `In progress`): Claude Code startet im Workspace mit dem Developer-Teil des Prompts. Der
   Agent
   - liest `AGENTS.md`, `CLAUDE.md` und `README.md` des Repositories sowie Kommentare und Pull Requests des Issues
     (auch frühere Reviews),
   - setzt das Issue auf `In progress` und kommentiert seinen Plan,
   - arbeitet auf dem Branch `symphony/issue-<nr>`, oder auf einem Branch, den du im Issue verknüpft hast,
   - implementiert und testet, merged den Basis-Branch hinein, committet, pusht und öffnet einen Pull Request mit
     `Closes #<nr>`,
   - kommentiert das Ergebnis und ruft `set_status("Agent review")` auf.
4. **Checks vor `Agent review`:** Symphony führt die Checks im Workspace aus. Bestehen sie, wandert die Karte nach
   `Agent review` und die Developer-Session endet. Scheitern sie (`check_failed`), bleibt die Karte stehen und der
   Agent bekommt die Ausgabe, behebt die Fehler und versucht es erneut. Ist die Umgebung kaputt (`check_error`, z. B.
   fehlendes `vendor/`), kommentiert er das und schiebt die Karte nach `Blocked`.
5. **Reviewer** (`Agent review`, höchstens einer gleichzeitig, Modell `opus`, nur lesend, 6 Turns): prüft
   `git diff origin/<base>...HEAD`, den Pull Request und die Kommentare anhand einer Checkliste (Korrektheit, Tests,
   Autorisierung, Validierung, N+1, Migrationen, Secrets, geänderte Test-/CI-/Lint-Konfiguration) und schreibt
   **einen** Kommentar `## Agent review (round N)`. Danach:
   - **freigegeben:** `In review`. Vorher laufen die Checks noch einmal; für einen unveränderten Commit nimmt Symphony
     das gespeicherte Ergebnis.
   - **Änderungen nötig:** zurück nach `In progress`; der Developer arbeitet die Befunde ab (Schritt 3).
   - **ab Runde 3:** keine weitere Schleife, sondern `In review` mit der Liste der offenen Befunde für dich.
6. Nach jedem Turn prüft Symphony das Issue. Wechselt es in die Spalte einer anderen Rolle, endet die Session und die
   nächste Rolle startet eine Sekunde später in einer frischen Session. Steht es noch in einer Spalte derselben Rolle,
   bekommt der Agent weitere Turns bis `max_turns`, danach eine neue Session. Höchstens `SYMPHONY_MAX_CONTINUATIONS`
   (Standard 6) solcher Sessions inklusive Rollenwechsel, dann wird das Issue pausiert.
7. Du prüfst den Pull Request, mergst ihn und schiebst die Karte nach `Done`. Symphony löscht dann den Workspace. Nur
   du setzt `Done`; Symphony verweigert Agenten diesen Wechsel.

| Spalte | Was Symphony tut |
|---|---|
| `Backlog` | nichts. Issues hier sind noch nicht freigegeben. |
| `Ready` | startet einen Developer, sobald ein Platz frei ist |
| `In progress` | ein Developer arbeitet; findet Symphony hier ein Issue ohne Agenten, startet es einen |
| `Agent review` | startet einen Reviewer (höchstens einen gleichzeitig); nur nach bestandenen Checks erreichbar |
| `Blocked` | stoppt einen laufenden Agenten; der Workspace bleibt erhalten. Der Agent braucht dich, siehe sein Kommentar. |
| `In review` | stoppt einen laufenden Agenten; der Workspace bleibt für Nacharbeiten erhalten. Nur der Reviewer schiebt hierher, nach bestandenen Checks. |
| `Done` | stoppt einen laufenden Agenten und löscht den Workspace, spätestens beim nächsten Abfragen |

Willst du Nacharbeiten, kommentiere im Issue und schiebe es zurück nach `Ready` oder `In progress`. Der Developer
macht im selben Workspace weiter und liest deine Kommentare. Ein Issue aus `Blocked` schiebst du nach Klärung
ebenso zurück.

### Umstieg vom Ein-Prompt-Setup

Bis zu dieser Version hatte die `WORKFLOW.md` einen einzigen Prompt: Ein Agent arbeitete von `Ready` bis `In review`.
Für den Umstieg auf Rollen:

1. **Board:** die Spalten `Agent review` und `Blocked` anlegen (siehe
   [Board einrichten](getting-started.md#2-github-project-board-einrichten)). Laufende Issues können in ihren Spalten bleiben.
2. **`WORKFLOW.md`:** die mitgelieferte Datei übernehmen. Hast du eine eigene, ergänze:
   - `tracker.active_states: [Ready, In progress, Agent review]`,
   - den Abschnitt `roles` (`developer` für `Ready` und `In progress`, `reviewer` für `Agent review`),
   - `checks.on_enter` für `Agent review` und `In review` mit `checks/laravel.sh`,
   - `agent.max_concurrent_agents_by_state: { "Agent review": 1 }` und ein Limit für `agent.max_continuations`
     (ohne Limit warnt Symphony, weil jeder Rollenwechsel als Fortsetzung zählt),
   - `bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"` im Hook `after_create`,
   - im Prompt `{% case role %}` mit Abschnitten `{% when "developer" %}`, `{% when "reviewer" %}` und einem
     `{% else %}` mit deinem bisherigen Prompt als Rückfallebene.
   Ein vollständiges Beispiel steht in [configuration.md](configuration.md#complete-example-roles-checks-and-laravel).
3. **`.env`:** `SYMPHONY_MAX_CONTINUATIONS=6` setzen. Der alte Wert `2` reicht für Developer, Reviewer und eine
   Nachbesserungsrunde nicht.
4. **Prüfen:** `npm run dry-run` darf keine `unknown board column` melden und zeigt den Prompt der Rolle des ersten
   Kandidaten.

Bestehende Workspaces bekommen den `after_create`-Hook nicht nachträglich. Für Laravel-Apps darin einmal im
Workspace `bash ~/projects/symphony/hooks/laravel-env.sh` ausführen oder den Workspace löschen.
Zurück zum alten Verhalten kommst du, indem du `roles` und `checks` entfernst: Dann läuft jedes Issue mit der Rolle
`default` und dem `{% else %}`-Prompt.

## Eingreifen während des Betriebs

| Ziel | So geht's |
|---|---|
| Einen Agenten stoppen | Issue nach `Backlog`, `Blocked` oder `In review` schieben. Er stoppt beim nächsten Abfragen, spätestens nach 30 s. |
| Abbrechen und aufräumen | Issue nach `Done` schieben |
| Alle neuen Starts pausieren | in der `WORKFLOW.md` `agent.max_concurrent_agents: 0` setzen. Laufende Agenten arbeiten weiter. |
| Prompt oder Einstellungen ändern | `WORKFLOW.md` bearbeiten. Das gilt sofort für neue Sessions, ohne Neustart. |
| Wartenden oder pausierten Worker sofort neu starten | im Dashboard (Warteschlange, Pausiert-Liste oder Agent-Seite) auf **Retry now** bzw. **Resume now** klicken, oder `curl -X POST http://127.0.0.1:4000/api/v1/<identifier>/retry` (den Identifier URL-kodiert, z. B. `cooolinho%2Ftrainingsstunden-portal%2312`). Das ist der Weg nach einem Session-Limit, wenn du Guthaben aufgeladen hast und nicht bis zum Reset warten willst. Bei einer Nicht-Loopback-Adresse (`SYMPHONY_HOST`) geht es nur mit `SYMPHONY_ALLOW_REMOTE_CONTROL=true`; per `curl` über den Proxy dann `-H 'Origin: https://<domain>'` mitgeben, siehe [Dashboard und API](#dashboard-und-api). |
| Sofort abfragen statt 30 s zu warten | im Dashboard auf **Poll now** klicken, oder `curl -X POST http://127.0.0.1:4000/api/v1/refresh` |

Ist die `WORKFLOW.md` nach einer Änderung fehlerhaft, läuft Symphony mit der letzten gültigen Version weiter. Neue
Agenten startet es dann erst wieder, wenn der Fehler behoben ist. Die Meldung steht im Log und im Dashboard.

## Fehlschläge und Wiederholungen

Scheitert ein Lauf, versucht Symphony es erneut. Gründe können ein fehlgeschlagener Hook sein, ein Fehler des
Agenten, eine Zeitüberschreitung oder eine hängende Session (10 Minuten ohne Aktivität). Die Wartezeit verdoppelt
sich jedes Mal: 10 s, 20 s, 40 s und so weiter, höchstens 10 Minuten (`agent.max_retry_backoff_ms`). Die
Warteschlange mit Grund und nächstem Termin siehst du im Dashboard. Beim nächsten Versuch weiß der Agent über
`attempt`, dass es schon Vorarbeit im Workspace gibt. Ein erreichtes Session-Limit behandelt Symphony gesondert,
siehe [Session-Limit](#session-limit).

Die **Wiederholungs-Warteschlange** und **Paused** sind zwei verschiedene Dinge: In der Warteschlange hat Symphony
für das Issue einen nächsten Versuch mit Termin geplant (nach einem Fehlschlag, einer Fortsetzung oder einem
Session-Limit). Unter *Paused* steht ein Issue, das nach `SYMPHONY_MAX_CONTINUATIONS` Fortsetzungen noch aktiv ist;
dafür ist kein Termin geplant, siehe [Fortsetzungen und Pausieren](#fortsetzungen-und-pausieren).

## Session-Limit

Erreicht dein Claude-Abonnement sein Nutzungslimit (Meldung `You've hit your session limit · resets 7:30pm`, das
5-Stunden-Fenster oder ein Wochenlimit), bringt eine Wiederholung nach 10 Sekunden nichts. Symphony geht deshalb
in zwei Stufen vor:

1. **Retries:** Bis zu `SYMPHONY_MAX_SESSION_LIMIT_RETRIES` Mal (Standard 3) versucht Symphony das Issue nach dem
   ersten Session-Limit-Fehler erneut, mit der üblichen Wartezeit (10 s, 20 s, 40 s …).
2. **Warten bis zum Reset:** Ist das Limit danach immer noch erreicht, wartet der Worker bis zum Reset. `retry at` ist
   der Reset-Zeitpunkt plus 1 Minute. Mit `0` wartet Symphony schon nach dem ersten Fehler. Danach läuft es
   wie ein normaler Retry weiter. Verlässt die Karte in der Zwischenzeit die aktiven Spalten oder wird sie geschlossen, gibt Symphony das
   Issue frei.

**Wo du es siehst:**

- Im Dashboard in der Wiederholungs-Warteschlange: Badge *Session limit*, Fenster, Reset-Zeitpunkt, `retry N of M`
  bzw. *waiting for reset*, dazu die Originalmeldung. Beim Warten steht das Issue nicht unter *Paused*.
- Auf der Agent-Seite (`/agent?id=<identifier>`) als Hinweis *Session limit reached* mit Fenster, Reset und Retries.
  Der Ablauf erscheint als `run_finished` mit dem Ergebnis `session_limit` und als Ereignis `session_limit_wait`.
- In `GET /api/v1/state` im Eintrag unter `retrying[]`: `kind` ist `session_limit`, und das Feld `limit` enthält
  `window`, `resets_at`, `source`, `text`, `hits`, `max_retries`, `waiting`, `overage_disabled_reason` und
  `observed_at`. Bei anderen Retries ist `limit` `null`.
- Im [Repository-Log](#logs-und-statistiken) als `session_limit_wait`.

**Wie Symphony den Reset findet:** Zuerst nimmt es den Zeitpunkt aus dem strukturierten `rate_limit_event` von Claude
Code (`source` = `event`). Fehlt er, liest es die Uhrzeit aus der Meldung (`source` = `message`, z. B.
`resets 7:30pm (Europe/Berlin)`). Ist der Reset unbekannt oder mehr als 8 Tage voraus,
bleibt es beim bisherigen Backoff der Fehlschläge und der Worker wartet nicht auf einen Zeitpunkt.

**Keine neuen Issues während des Wartens:** Das 5-Stunden-Fenster (`five_hour`) und das Wochenlimit (`seven_day`)
gelten für das ganze Konto. Solange ein Worker auf den Reset eines dieser Limits wartet, startet Symphony keine neuen
Issues, statt sie einzeln in das Limit laufen zu lassen (jedes würde einen Workspace anlegen, sofort scheitern und
eigene Retries verbrauchen). Laufende Agenten, Retries und der Abgleich mit dem Board laufen weiter. Die Sperre endet
von selbst, wenn das Warten endet (Reset erreicht, Issue freigegeben, **Retry now**) oder ein Turn irgendeines Agenten
nach dem Limit erfolgreich endet. Warten mehrere Worker, gilt die Sperre bis zum spätesten Termin. Das Dashboard zeigt
dann den Hinweis *Dispatch paused until … · session limit (five_hour) · started by …*, `GET /api/v1/state` das Feld
`health.dispatch_gate` (`reason`, `window`, `until`, `issue_identifier`, sonst `null`). Modellspezifische Limits
(`seven_day_opus`, `seven_day_sonnet`), `overage` und Limits ohne bekanntes Fenster sperren nichts.

**Grenzen:**

- Das Warten steht nur im Speicher. Startest du Symphony neu, ist es vergessen: Das Issue wird wie jedes aktive Issue
  neu abgefragt und startet, und ist das Limit noch aktiv, beginnt der Ablauf von vorn.
- Nur Session-Limits eines Claude-Abonnements zählen. Rate-Limits (HTTP 429) eines `ANTHROPIC_API_KEY` bleiben
  gewöhnliche Fehlschläge mit Backoff.
- Ein modellspezifisches Wochenlimit (Opus oder Sonnet) parkt nur das betroffene Issue. Issues mit anderem Modell
  laufen weiter.
- Mit **Retry now** (Abschnitt [Eingreifen während des Betriebs](#eingreifen-während-des-betriebs)) beendest du das
  Warten sofort, etwa nach dem Aufladen von Guthaben (`overage_disabled_reason` = `out_of_credits`). Der Zähler der
  Retries beginnt dann von vorn. Ist das Limit noch aktiv, ist der Worker nach wenigen Fehlschlägen wieder im Wartemodus.

## Abhängigkeiten und Sub-Issues

Ein Issue wartet, solange etwas offen ist, wovon es abhängt. Es bleibt dabei in `Ready`, und Symphony startet es
automatisch, sobald alles erledigt ist. Drei Arten von Abhängigkeiten zählen:

| Art | So legst du sie an |
|---|---|
| Relationship | In der Seitenleiste des Issues unter **Relationships → Blocked by** |
| Text im Issue | In der Beschreibung, z. B. `blocked by #12`, `blocked #12` oder `Blocked by: #12, #13`. `#N` meint dasselbe Repository, andere gehen als `owner/repo#N`. |
| Sub-Issues | In der Seitenleiste unter **Sub-issues**. Das Parent-Issue wartet, bis alle Sub-Issues geschlossen sind. Ausnahme: Ein Issue, dessen Beschreibung mit einem [Befehl](#befehle-im-issue-refactoring) beginnt, wartet nicht, denn bei ihm sind die Sub-Issues das Ergebnis des Laufs. Eine Rolle mit `wait_for_sub_issues` (der [Autopilot](#autopilot-auto-code)) wartet trotzdem: Sie startet erst wieder, wenn ihre Sub-Issues geschlossen sind. |

Die Agenten-Befehle `/concept` setzen beide Arten zugleich: die Relationship (`blocked_by` an `create_sub_issue`) und die
Zeile `Blocked by #N` im Text. Beides zählt als eine Abhängigkeit.

Erledigt ist eine Abhängigkeit, wenn das Issue **geschlossen** ist; bei einem referenzierten Pull Request, wenn er
gemergt oder geschlossen ist. Agenten schließen keine Issues selbst. Eine Abhängigkeit löst sich also, sobald du den
zugehörigen Pull Request mit `Closes #N` mergst. So baut das nächste Issue auf gemergtem Code auf. Referenzen auf nicht
existierende Issues werden ignoriert. Warum ein Issue wartet, zeigt `npm run dry-run`. Der Agent sieht Parent,
Sub-Issues und Abhängigkeiten im Prompt.

## Befehle im Issue: /refactoring

Eine Aufgabe, die in vielen Repositories gleich abläuft, legst du nicht in jedes Repository, sondern einmal in
Symphony als Skill (`.claude/skills/`). Ein Issue ruft sie über eine Befehlszeile auf: Steht in der **ersten nicht
leeren Zeile** der Beschreibung `/<name>` (optional mit Argumenten), lädt der Agent den Skill `symphony:<name>`. Der
Issue-Text bleibt kurz, die Anleitung steckt im Skill. Technik und Auswahlregeln:
[configuration.md](configuration.md#issue-commands).

Symphony liefert vier Befehle mit:

| Befehl | Zweck |
|---|---|
| `/refactoring [Scope]` | Audit eines Laravel-/Filament-Repositories: Kontext, Baseline, Bugs und Refactoring-Kandidaten. Das Ergebnis sind Sub-Issues. |
| `/refactor-safely` | Verhaltensneutral umbauen, Tests als Sicherheitsnetz. Steht in der ersten Zeile jedes Refactoring-Sub-Issues. |
| `/auto-code [Beschreibung] [wave=3] [checkpoint=5] [issue-models=auto]` | [Autopilot](#autopilot-auto-code): entwickelt das Repository aus seiner Projektbeschreibung fortlaufend weiter, in Wellen von Sub-Issues, die sofort umgesetzt werden. |
| `/concept <Pfad> [issue-models=auto]` | [Konzept zu Backlog](#konzept-zu-backlog-concept): zerlegt ein Konzept (Markdown-Datei) in Epics und Sub-Issues mit Abhängigkeiten sowie Model- und Effort-Labels. Alles landet im Backlog. |

### Ablauf des Audits

1. Lege im Ziel-Repository ein Issue an. Titel z. B. „Refactoring-Audit“, Beschreibung nur `/refactoring`, oder mit
   Scope `/refactoring app/Filament`.
2. Schiebe es nach **Ready**. Die Rolle `auditor` übernimmt (`opus`, nur lesend, keine Entry-Checks, Budget aus
   `roles.auditor.claude.max_budget_usd`).
3. Der Agent ermittelt den Kontext aus `composer.lock` und `package.json` (PHP, Laravel, Filament, Livewire, Pest,
   Vite …), misst die Baseline (Tests, Analyse, Pint, `composer audit`, `npm audit`, Build) und analysiert mit Laravel
   Boost (`search-docs` gegen die installierte Version, Schema, Routen). Er **ändert nichts**.
4. Die Befunde werden Sub-Issues des Audit-Issues, in der Spalte **Backlog** (`tracker.provider.sub_issue_status`):
   zuerst Sub-Issues für Characterization-Tests, dann Refactorings (`/refactor-safely`, mit `Blocked by #N` auf die Tests),
   dann Bugs (Label `bug`, ohne Befehl). Dazu ein Report-Kommentar mit Kontext, Baseline und Checkliste. Das Audit-Issue
   springt nach **In review** und ist damit das Epic.
5. Du prüfst die Sub-Issues, streichst oder ergänzt sie und schiebst die, die umgesetzt werden sollen, nach **Ready**.
   Die Reihenfolge ergibt sich aus den Abhängigkeiten ([oben](#abhängigkeiten-und-sub-issues)): Ein Refactoring wartet,
   bis das Test-Sub-Issue gemergt und geschlossen ist.
6. Ein Refactoring-Sub-Issue läuft durch den normalen Weg Developer → Reviewer → In review. Der Developer schreibt zuerst
   die Tests, die das heutige Verhalten festhalten, und ändert danach keine bestehende Assertion. Der Reviewer prüft den
   Test-Diff und meldet jede Verhaltensänderung als blocker. Bugs behebt der normale Developer-Ablauf, mit einem
   Regressionstest, der erst rot und dann grün ist.

Dass die Sub-Issues im Backlog landen, ist Absicht: Ein Audit kann 20 Befunde liefern, und du entscheidest, welche
Läufe (und Kosten) du startest. Wer ein Audit wiederholt, schiebt das Epic erneut nach Ready. Der Skill setzt dann fort,
statt neu zu beginnen: Ein Sub-Issue mit demselben Titel wird nicht doppelt angelegt.

**Voraussetzungen.** Das Board braucht die Spalten `Backlog` und `In review`. Das Ziel-Repository sollte `laravel/boost`
als Dev-Abhängigkeit haben ([Laravel Boost](#laravel-boost)); ohne Boost arbeitet der Skill eingeschränkt und vermerkt
das im Report. Der Token braucht Schreibrechte auf Issues und das Projekt (klassisch: `repo` und `project`).

**Grenzen.** Höchstens `roles.auditor.max_sub_issues` Sub-Issues sind gleichzeitig offen (Standard 20); weitere stehen
im Report unter „Nicht angelegt“. Ein unbekanntes `/wort` ohne Skill ist ein ganz normales Issue. Ein Befehl im
Beschreibungstext weiter unten gilt nicht.

### Eigene Befehle

1. Lege `.claude/skills/<name>/SKILL.md` im Symphony-Repository an ([Regeln](../.claude/README.md)). Die
   `description` sollte sagen, dass der Skill nur auf Verlangen des Prompts geladen wird.
2. Ein Befehl ohne eigene Rolle läuft in der Rolle der Spalte (Developer oder Reviewer) und lädt nur den Skill. Braucht
   er eigene Rechte oder Tools (nur lesen, Sub-Issues anlegen, keine Checks), füge eine Rolle mit `commands: [<name>]`
   in `WORKFLOW.md` hinzu und einen Zweig im Prompt (`{% when "<rolle>" %}`).
3. Prüfe mit `npm run dry-run`: Für das Issue erscheinen die Rolle und `↳ command /<name> → symphony:<name>`. Fehlt der
   Skill, meldet die Dispatch-Validierung `no skill for /<name> in claude.plugins`.

## Autopilot: /auto-code

Mit `/auto-code` entwickelt Symphony ein Repository selbstständig weiter. Der einzige Auftrag ist die
Projektbeschreibung im Repository. Daraus plant der Agent neue Features, Design-, Qualitäts- und Wartungsaufgaben, setzt
sie um und plant danach die nächsten. Das geht so lange weiter, bis du das Epic stoppst.

Die Arbeit läuft in **Wellen**:

```
Epic "/auto-code docs/index.md" → Ready
  → Planer (opus, nur lesend): liest Projektbeschreibung, Roadmap, Code auf develop und deine Kommentare im Epic
  → Welle N: 3 Sub-Issues direkt in Ready (Labels auto-code, Kategorie, Effort), Bericht im Epic
  → das Epic bleibt "In progress" und wartet, bis alle Sub-Issues der Welle geschlossen sind
       je Sub-Issue: Developer → PR nach develop → Entry-Checks → Reviewer → "In review"
                     → Symphony merged den PR in develop, schließt das Issue, setzt es auf Done
  → der Planer startet erneut → Welle N+1
  → nach Welle 5, 10, …: Checkpoint-Bericht und Release-PR develop → main, das Epic geht nach "In review"
```

Die Anleitung des Planers steht im Skill [`auto-code`](../.claude/skills/auto-code/SKILL.md). Er wählt Ideen nur mit
Bezug zur Projektbeschreibung und Beleg im Code, hält Mischregeln ein (höchstens ein Wartungs-Issue pro Welle,
regelmäßig Qualität, keine wiederholten Redesigns derselben Seite) und pausiert lieber, als Beschäftigungstherapie zu
liefern ([Kriterien](../.claude/skills/auto-code/ideation.md)).

### Einrichten

1. **Projektbeschreibung:** Das Ziel-Repository braucht eine Beschreibung mit erkennbarem Ziel, z. B. `docs/index.md`.
   Eine Roadmap (`docs/todo.md`) arbeitet der Planer zuerst ab. Sehr empfohlen ist ein Abschnitt „Leitplanken für den
   Autopiloten“ mit Nicht-Zielen, Prioritäten und Design-Prinzipien
   ([Vorlage](../.claude/skills/auto-code/vision-template.md)).
2. **Integrations-Branch:** `develop` aus `main` anlegen und pushen (`git switch -c develop main && git push -u origin develop`).
3. **Env der Instanz:** `SYMPHONY_BASE_BRANCH=develop` (Agenten klonen, branchen und öffnen PRs gegen `develop`) und
   `SYMPHONY_AUTO_MERGE=true` (Symphony merged freigegebene PRs in `develop`). Danach Symphony neu starten.
4. **Labels:** `npm run repo-init` → *Standard labels* legt `auto-code`, `feature`, `design`, `quality`, `maintenance`
   und `manual-merge` an, dazu `concept` und `epic` für [`/concept`](#konzept-zu-backlog-concept).
5. **Epic:** ein Issue, z. B. „Autopilot“, mit der Beschreibung `/auto-code docs/index.md` (optional `wave=3
   checkpoint=5 issue-models=auto`), nach **Ready** schieben. Text unter der Befehlszeile gilt als Teil des Auftrags (z. B. Schwerpunkte).

Prüfen mit `npm run dry-run`: Das Epic erscheint mit `role=planner` und `↳ command /auto-code → symphony:auto-code`,
während einer Welle mit `waiting for sub-issues …`.

### Modell pro Sub-Issue (`issue-models`)

Ohne Angabe laufen die Sub-Issues mit dem Modell aus `CLAUDE_MODEL`. Mit dem Argument `issue-models` setzt der Planer
beim Anlegen ein [Modell-Label](#modell-pro-issue-wählen):

| Argument | Wirkung |
|---|---|
| (fehlt) oder `issue-models=off` | keine Modell-Labels, es gilt `CLAUDE_MODEL` |
| `issue-models=opus`, `sonnet` oder `haiku` | alle Sub-Issues bekommen `Model: <wert>` |
| `issue-models=auto` | der Planer wählt je Issue nach Aufwand und Risiko: `Model: haiku` für kleine, risikoarme Änderungen, `Model: sonnet` als Normalfall, `Model: opus` bei hohem Risiko, großem Zuschnitt oder Major-Upgrades |

Das Label gilt für Developer und Reviewer des Sub-Issues. Der Planer nennt Label und Grund je Issue im Wellen-Bericht.
Die Labels `Model: opus|sonnet|haiku` müssen im Repository existieren (`npm run repo-init` → *Standard labels*);
fehlt eines, meldet der Planer es im Bericht und das Issue läuft mit `CLAUDE_MODEL`. Das Argument gilt für jede Welle
des Epics; zum Ändern die Befehlszeile in der Beschreibung anpassen.

### Steuern und stoppen

| Du willst | So geht es |
|---|---|
| etwas Bestimmtes als Nächstes | Kommentar im Epic, z. B. „Als Nächstes PDF-Export der Abrechnung“. Der Planer setzt Wünsche vorrangig um und sagt im Bericht, was er damit gemacht hat. |
| eine Idee ablehnen | Das Sub-Issue als **not planned** schließen. Der Planer schlägt sie nie wieder vor, auch nicht umformuliert. |
| einen PR selbst mergen | Label `manual-merge` an Issue oder PR. Symphony lässt ihn in „In review“ liegen. Major-Upgrades bekommen es automatisch. |
| am Checkpoint weitermachen | Release-PR prüfen und mergen (oder nicht), Fragen im Epic beantworten, Epic zurück nach **Ready**. |
| anhalten | Epic nach **Backlog** schieben. Laufende Sub-Issues laufen zu Ende. Zurück nach **Ready** setzt fort. |
| beenden | Epic nach **Done** schieben. |

Ein früher Checkpoint kommt, wenn du in einer Welle zwei oder mehr Sub-Issues ablehnst: Dann passt die Richtung nicht.
Findet der Planer nichts mehr, das die Kriterien erfüllt, schreibt er „Auto-Code Pause“ und geht nach „In review“.

### Auto-Merge nach develop

`tracker.provider.auto_merge` merged, sobald der Reviewer ein Issue nach `on_enter` (hier „In review“) verschiebt, also
nach bestandenem Agent-Review **und** bestandenen Entry-Checks:

- nur Pull Requests vom Issue-Branch (`symphony/issue-N` bzw. dem verknüpften Branch) nach `base_branch`, nie in den
  Default-Branch, keine Drafts, nichts mit dem Label `manual-merge`;
- Squash-Merge des geprüften Commits (`expectedHeadOid`), danach schließt Symphony das Issue (GitHub tut das bei
  Merges in einen anderen Branch als den Default-Branch nicht) und setzt es auf **Done**;
- bei einem Merge-Konflikt geht das Issue nach **In progress** zurück, mit einem Kommentar für den Developer;
- ohne Pull Request passiert nichts (so bei der Übergabe von Auditor und Planer); Drafts, `manual-merge` und ein
  Fehlschlag bleiben in „In review“ und bekommen einen Kommentar mit dem Grund.

Auto-Merge gilt für alle Issues der Instanz, nicht nur für die des Autopiloten. Deine eigenen Issues landen also
ebenfalls gemergt in `develop`. Nach `main` kommt nur, was du per Release-PR übernimmst.

### Grenzen und Kosten

- Ein Epic fasst höchstens 100 Sub-Issues (GitHub). Ab 80 schreibt der Planer eine Übergabe; leg dann ein neues Epic an
  und kopiere den Abschnitt unter die Befehlszeile.
- Die Welle ist erst fertig, wenn **alle** ihre Sub-Issues geschlossen sind. Ein Sub-Issue in „Blocked“ hält den
  Autopiloten an, bis du es löst oder schließt.
- Kosten: pro Welle ein Planer-Lauf (`roles.planner.claude.max_budget_usd`, Standard 10 $) plus Developer- und
  Reviewer-Läufe pro Sub-Issue. Bremsen: kleinere Wellen (`wave=2`), häufigere Checkpoints, wenige parallele Agenten,
  ein günstigeres Modell für die Umsetzung (`CLAUDE_MODEL=sonnet`).
- Der Planer sieht die Oberfläche nicht. Design-Issues schreibt er deshalb mit konkreten, testbaren Kriterien.

## Konzept zu Backlog: /concept

Mit `/concept <Pfad>` wird aus einem Konzept ein Arbeitsplan auf dem Board. Du schreibst das Konzept als Markdown-Datei
ins Repository (z. B. `docs/index.md`), legst ein Issue mit der Beschreibung `/concept docs/index.md` an und schiebst es
nach **Ready**. Die Rolle `analyst` (`opus`, nur lesend, keine Entry-Checks) liest das Konzept, prüft, was der Code schon
kann, und legt zwei Ebenen von Issues an:

```
#10 /concept docs/index.md                      → In review, wenn der Plan steht
├─ #11 Epic: Benutzerverwaltung                 Backlog · Labels epic, concept
│  ├─ #13 Feature: Anmeldung                    Backlog · concept, feature, Effort: high, Model: sonnet
│  └─ #14 Feature: Rollen und Rechte            Backlog · … Effort: xhigh, Model: opus · blocked by #13
└─ #12 Epic: Abrechnung                         Backlog
   └─ #15 Feature: Rechnung anlegen             Backlog · … blocked by #14
```

Jedes Issue bekommt Akzeptanzkriterien, den Bezug zum Konzeptabschnitt, Tests, **Abhängigkeiten** (GitHub-Relationship
und Zeile `Blocked by #N`), eine Kategorie (`feature`, `design`, `quality`, `maintenance`), genau ein `Effort: …`-Label und
ein `Model: …`-Label. Alle landen in **Backlog** (`tracker.provider.sub_issue_status`); sie starten erst, wenn du sie
nach **Ready** schiebst. Die Anleitung steht im Skill [`concept`](../.claude/skills/concept/SKILL.md), der Zuschnitt in
[breakdown.md](../.claude/skills/concept/breakdown.md).

### Einrichten

1. **Konzept:** eine Markdown-Datei auf dem Basis-Branch (`SYMPHONY_BASE_BRANCH`, sonst der Default-Branch), denn dort
   klont der Agent. Relativ verlinkte `.md`-Dateien liest er eine Ebene tief mit. Gut sind Ziel, Rollen, Funktionsbereiche,
   Abläufe, Nicht-Ziele und offene Fragen.
2. **Labels:** `npm run repo-init` → *Standard labels* legt `concept`, `epic`, die `Model: …`- und `Effort: …`-Labels sowie
   die Kategorien an. Fehlt ein Label, legt der Agent das Issue ohne an und sagt es im Bericht.
3. **Issue:** Beschreibung `/concept docs/index.md`, optional `issue-models=auto|opus|sonnet|haiku|off` (Standard
   `auto`) und darunter Text mit Schwerpunkten oder Ausschlüssen. Danach nach **Ready**.

Prüfen mit `npm run dry-run`: Das Issue erscheint mit `role=analyst` und `↳ command /concept → symphony:concept`.

### Ablauf

1. Der Agent liest das Konzept und den Stand des Repositories und ordnet jeden Bereich ein (vorhanden, teilweise, fehlt).
2. Er schneidet Epics (2 bis 10 Issues, fachlich abgeschlossen) und Issues (einzeln mergbar, Größe S oder M) und ordnet sie
   nach Abhängigkeiten. Jede Anforderung des Konzepts landet in einem Issue oder unter „Nicht angelegt“; Lücken werden
   Fragen, keine erfundenen Issues.
3. Er postet den Kommentar **`## Konzept-Plan`**, **bevor** er etwas anlegt: Baum, Labels, Reihenfolge und eine Abdeckungsliste.
4. Er legt Epics und Issues an, Blocker zuerst. Ein Epic entsteht, wenn sein erstes Issue dran ist.
5. Er postet **`## Konzept-Bericht`** mit dem Baum samt Issue-Nummern, dem Grund für Modell und Effort je Issue, „Nicht
   angelegt“, offenen Fragen und Hinweisen. Das Konzept-Issue geht nach **In review**.

Die Labels richten sich nach Aufwand und Risiko ([Tabellen](../.claude/skills/concept/breakdown.md#labels)): `Effort: low`
für Texte und Konfiguration, `medium` für kleine, `high` für mittlere Aufgaben, `xhigh` bei Datenmodell, Rechten, Geld oder
Migrationen. `Effort: max` vergibt der Agent nicht. Mit `issue-models=auto` wählt er `Model: haiku`, `sonnet` oder
`opus`; ein fester Wert setzt dasselbe Modell an alle Issues, `off` lässt die Modell-Labels weg.

### Danach

| Du willst | So geht es |
|---|---|
| ein Issue umsetzen lassen | Issue von **Backlog** nach **Ready** schieben. Hat es offene Blocker, wartet es dort und startet, sobald sie geschlossen sind (Pull Request gemergt). |
| ein Issue streichen oder ändern | Im Backlog schließen oder bearbeiten, bevor es nach Ready geht. |
| das Konzept erweitern | Konzept ändern und committen (auf den Basis-Branch), Wünsche als Kommentar im Konzept-Issue, das Issue zurück nach **Ready**. Der Agent macht einen **Nachtrag** und legt nur an, was im Bericht fehlt. |
| einen Abbruch beheben | Bricht ein Lauf ab, setzt Symphony ihn fort (oder du schiebst das Issue zurück nach **Ready**). Der Agent übernimmt den Plan-Kommentar und legt ohne Duplikate nur Fehlendes an: Derselbe Titel unter demselben Epic liefert das vorhandene Issue zurück. |

Die **Epics nicht nach Ready schieben**: Sie sind Container. Ein Epic mit offenen Sub-Issues wird ohnehin nicht gestartet.
Schließe es von Hand, wenn alle Sub-Issues erledigt sind.

### Grenzen

- Höchstens `roles.analyst.max_sub_issues` (Standard 60) offene Issues gleichzeitig; Epics zählen mit, ebenso die Issues
  darin. Was nicht mehr hineinpasst, steht im Bericht unter „Nicht angelegt“. Sind Issues erledigt und geschlossen, holt
  ein Nachtrag den Rest nach.
- Abhängigkeiten zeigen nie auf ein Epic, sondern auf konkrete Issues, auch über Epics hinweg, nie im Kreis.
- Der Agent ändert nichts im Repository und sieht die Oberfläche nicht; Design-Issues bekommen deshalb konkrete Kriterien.
- Kosten: ein Lauf pro Konzept und Nachtrag (`roles.analyst.claude.max_budget_usd`, Standard 20 $), dazu später die
  Läufe der Issues, die du freigibst.

## Fortsetzungen und Pausieren

Endet eine Session regulär, das Issue steht aber noch in einer aktiven Spalte, startet Symphony nach einer
Sekunde eine **Fortsetzungs-Session**. Der Agent war dann nicht fertig, etwa weil `max_turns` erreicht war. Damit ein
Issue nicht endlos Sessions verbraucht, begrenzt `SYMPHONY_MAX_CONTINUATIONS` diese Fortsetzungen. Auch jeder
Wechsel der Rolle (Developer → Reviewer und zurück) startet eine Fortsetzungs-Session. Mit dem Wert `6` bekommt ein
Issue höchstens sieben Sessions: die erste und sechs Fortsetzungen. Ist es danach immer noch aktiv, wird es
**pausiert**:

- Es bleibt für Symphony reserviert, aber kein Agent startet mehr dafür. Im Log erscheint die Warnung
  `issue paused`, und das Dashboard zeigt es unter **Paused**.
- Es geht von selbst weiter, sobald sich auf dem Board etwas daran ändert: ein Kommentar von dir (z. B. ein Hinweis
  für den Agenten), ein geändertes Label, eine bearbeitete Beschreibung oder eine andere Spalte. Dann startet eine
  frische Session, die deinen Kommentar liest.
- Verschiebst du die Karte in eine nicht aktive Spalte, wird die Pause aufgehoben, ohne dass etwas startet.
- Erhöhst du das Limit oder entfernst du es (`agent.max_continuations`, z. B. über `SYMPHONY_MAX_CONTINUATIONS` in
  der `.env` mit Neustart oder direkt in der `WORKFLOW.md`), ist die Pause ebenfalls aufgehoben.
- Mit **Resume now** im Dashboard oder `POST /api/v1/<identifier>/retry` (siehe [Eingreifen während des
  Betriebs](#eingreifen-während-des-betriebs)) setzt du ein pausiertes Issue sofort fort. Der Zähler der
  Fortsetzungen beginnt dann von vorn, und der nächste Lauf ist ein normaler Versuch, den `max_continuations` nicht
  gleich wieder pausiert.

Wie das genau abläuft: Bei jedem Tick liest `#reconcile` alle pausierten Issues vom Board neu. Es hebt die Pause auf,
wenn sich ihre Spalte oder ihr `updated_at` geändert hat oder wenn `agent.max_continuations` erhöht oder entfernt
wurde. Das Issue ist dann wieder ein normaler Kandidat. Einen Timer gibt es nicht: Ohne Änderung, Limit-Anhebung oder
Klick bleibt das Issue pausiert, auch über Stunden. Wartet ein Worker wegen eines Session-Limits, steht er in der
Wiederholungs-Warteschlange und nicht unter *Paused*; siehe [Session-Limit](#session-limit).

Fehlgeschlagene Läufe zählen hier nicht mit. Für sie gelten die Wiederholungen mit Wartezeit von oben.

## Modell pro Issue wählen

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
- Kontrolle: `npm run dry-run` zeigt pro Issue `↳ role …, model …` (ohne Rollen `default`) und bei einem Label `↳ model … (label "…")`. Beim Start steht das Modell in der Logzeile
  `dispatching issue` (`model=…`, bei einem Label auch `model_label=…`) und im Log des Repositorys bei `run_started`.
  Das Dashboard zeigt in der Spalte *Model* das Modell, das Claude Code tatsächlich nutzt.
- Im Prompt fehlen die Model-Labels in der Label-Liste des Agenten. Für seine Arbeit spielen sie keine Rolle.
- Den Denkaufwand wählst du auf dieselbe Weise, siehe [Effort pro Issue wählen](#effort-pro-issue-wählen).
- Nicht verwechseln mit `claude.fallback_model` in der `WORKFLOW.md`: Das ist ein Ausweichmodell, falls das Modell
  überlastet ist. Wählt ein Label genau dieses Modell, lässt Symphony das Ausweichmodell für diese Session weg.

## Effort pro Issue wählen

Der Effort steuert, wie viel Claude nachdenkt und wie gründlich es vorgeht. Er beeinflusst vor allem Kosten, Laufzeit
und Kontingent: `low` oder `medium` genügen für kleine Aufgaben (Tippfehler, Doku, ein Config-Wert), `xhigh` oder `max`
geben einem kniffligen Issue mehr Spielraum, ohne das Modell zu wechseln. Jede Session nutzt den Effort aus
`CLAUDE_EFFORT`, außer das Issue trägt ein Label `Effort: …`. Dann gilt für dieses Issue der Effort aus dem Label:

| Label | Effort für Claude Code |
|---|---|
| `Effort: low` | `low` |
| `Effort: medium` | `medium` |
| `Effort: high` | `high` |
| `Effort: xhigh` | `xhigh` |
| `Effort: max` | `max` |

- `repo-init` legt alle fünf Labels an, zusammen mit den Model-Labels.
- Groß- und Kleinschreibung spielen keine Rolle. Andere Werte (z. B. `Effort: hi`) sind unbekannt.
- Rangfolge: `Effort:`-Label vor dem `effort` der Rolle (`roles.<rolle>.claude.effort`) vor `CLAUDE_EFFORT` (also
  `claude.effort` in der `WORKFLOW.md`). Ist nichts davon gesetzt, gilt der Standard von Claude Code.
- Bei einem unbekannten Wert oder bei mehreren Labels mit verschiedenen Stufen gilt der Effort ohne Label. Symphony
  schreibt dann die Warnung `effort label ignored` ins Log und in den Dry Run.
- Der Effort gilt für eine ganze Session, genau wie das Modell: Eine Label-Änderung wirkt ab der nächsten Session.
- Unterstützt ein Modell eine Stufe nicht (z. B. Haiku), stuft Claude Code sie selbst herunter. Symphony prüft das
  nicht.
- Kontrolle: `npm run dry-run` zeigt pro Issue `↳ role …, model …, effort …` und bei einem Label
  `↳ effort … (label "…")`. Beim Start steht der Effort in der Logzeile `dispatching issue` (`effort=…`, bei einem
  Label auch `effort_label=…`) und im Log des Repositorys bei `run_started` (`effort=…`, `default` ohne Effort). Die
  Agent-Seite zeigt ihn in der Zeile des Sessionstarts.
- Im Prompt fehlen die Effort- und Model-Labels in der Label-Liste des Agenten (Filter `without_agent_labels`).

## Repositories einrichten (repo-init)

`repo-init` richtet die Repositories aus `GITHUB_REPOSITORY` interaktiv ein. Es gibt zwei Schritte: die
Standard-Labels (Modell, Effort und die Labels des [Autopiloten](#autopilot-auto-code)) und ein Issue, das Laravel Boost
einführt. Weitere Schritte kommen als Einträge in
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

## Orchestrierung testen (E2E)

`npm run e2e` prüft die Orchestrierung auf einem echten Board. Das Script legt neun Test-Issues mit Abhängigkeiten
an, alle mit `Model: sonnet`. Die Agenten kommentieren nur. Dann startet es eine eigene Symphony-Instanz und spielt
den Reviewer: Issues in `In review` setzt es nach 60 s auf `Done` und schließt sie. Am Ende prüft es, dass nie mehr
als `max_concurrent_agents` Agenten gleichzeitig liefen und dass kein Issue vor dem Schließen seiner Abhängigkeiten
gestartet wurde.

`npm run e2e -- --scenario roles` prüft stattdessen den Rollen-Ablauf developer → Checks → reviewer → Übergabe:
Es erzeugt einen Workflow mit den Rollen `developer` und `reviewer`, legt drei Test-Issues an und prüft deren
Status-Verlauf, die Zeilen `transition_denied`, `checks_finished` und `handed_off` im Repository-Log und das
Limit für `Agent review`. Das Board braucht dafür zusätzlich die Spalten `Agent review` und `Blocked`.

```bash
npm run e2e                                  # nutzt WORKFLOW.md und .env, wie npm start
npm run e2e -- --scenario roles              # Rollen-Ablauf mit generiertem Workflow
node scripts/e2e/verify.ts logs/e2e/<zeit>   # einen Lauf später erneut prüfen
```

Nimm dafür ein eigenes Test-Repository mit eigenem Board: Die Issues sind echt, und jeder Lauf kostet Claude-Nutzung
(etwa 0,50 USD). Das Script bricht ab, wenn auf dem Board schon Issues in aktiven Spalten stehen. Szenario,
Optionen und Prüfungen beschreibt [docs/e2e.md](e2e.md).

## Dashboard und API

Das Dashboard läuft nur, wenn `SYMPHONY_PORT` gesetzt ist oder du `npm start -- --port 4000` aufrufst. Es lauscht auf
der Adresse aus `SYMPHONY_HOST`, standardmäßig nur auf `127.0.0.1`. Im Header stehen Systemstatus, Workflow-Version, Poll-Intervall und letzter Poll. Jeder laufende Agent
erscheint als Karte mit Status, Issue, Repository, Spalte, Rolle, Modell, Phase, letzter Aktivität, Turns, Laufzeit,
Tokens und geschätzten Kosten. Arbeitet der Agent an einem Laravel-Projekt, trägt die Karte das **Laravel-Boost-Icon**:
farbig, wenn Boost für die Session bereitsteht, mit der Zahl der bisherigen Boost-Aufrufe (MCP-Tools und Skills), grau
mit ✕, wenn Boost fehlt oder nicht vorbereitet werden konnte. Der Tooltip nennt Status, Grund und die genutzten Tools
und Skills. Darunter folgen ein Aktivitäts-Stream (Änderungen zwischen den Abfragen, die letzten
Ereignisse der Agenten und Einträge aus den Repository-Logs), die Wiederholungs-Warteschlange, pausierte Issues und
Probleme wie Konfigurations- oder GitHub-Fehler. Der Button **Logs** öffnet die Log-Einträge in einer Seitenleiste mit
Filtern nach Repository, Schweregrad und Text; von dort (oder per Mittelklick auf den Button) führt ein Link zur
vollständigen [Logs-Seite](#logs-und-statistiken).

### Agent-Detailansicht (Execution Trace)

Ein Klick auf eine Agent-Karte (oder auf *trace →* in Warteschlange und Pausiert-Liste) öffnet `/agent?id=<identifier>`,
den Ablauf eines Agenten als Execution Trace. Oben stehen Zustand (Running, Retrying, Paused, Completed, Failed …),
Issue, Repository, Rolle, Modell, Phase, Laufzeit, Turn, Tokens und Kosten. Fehler und Wiederholungen erscheinen als
Banner mit Grund, fehlgeschlagenem Tool und nächstem Versuch; *View details* springt zur Stelle in der Timeline.

Die **Timeline** zeigt chronologisch alle Sessions des Issues seit dem Claim: Lifecycle (Session gestartet, beendet,
Retry geplant, pausiert), Phasenwechsel, Prompts, Modellaufrufe (Modell, Tokens, geschätzte Kosten, Zeit seit dem
vorigen Schritt), Antworten, Thinking und Tool-Calls mit Argumenten, Ergebnis, Status und Dauer. Filter (Lifecycle,
Phasen, Modell, Tools, Fehler) und eine Suche grenzen sie ein. Prompts, Antworten und Tool-Daten sind zugeklappt und
werden erst beim Aufklappen gerendert; Fehler stehen immer sichtbar im Eintrag. Neben der Timeline fassen Lifecycle,
Token-Verbrauch (mit einer kleinen Grafik pro Modellaufruf), Kosten pro Modell, Sessions und Laufkontext (Workspace,
Branch, Commit, letzter Entry-Check) den Stand zusammen. Bei Laravel-Projekten steht darüber der Abschnitt **Laravel
Boost**: ob der Agent Boost genutzt hat (z. B. *The agent used Laravel Boost in this session: 3 MCP tool calls and 1
skill loaded*), welche Boost-Tools und Skills wie oft, und was Boost bereitgestellt hat: Versionen, Guidelines (aus
welcher Datei und ob Claude Code sie selbst lädt oder sie im System-Prompt stehen), die Skills und wie viele davon
Claude Code tatsächlich geladen hat, den MCP-Server mit seinen freigegebenen Tools sowie Warnungen, falls
`boost:install` Guidelines oder Skills nicht geschrieben hat. Boost-Aufrufe tragen in der Timeline das Boost-Icon. *Show raw logs* öffnet alle Ereignisse als Terminal-Log mit
Schweregrad-Filter. Die Seite aktualisiert sich alle 2 s und hängt neue Einträge an, ohne die Scroll-Position zu
verlieren.

Woher die Daten kommen und wo die Grenzen liegen:

- Prompts, vollständige Antworten, Tool-Argumente und -Ergebnisse sowie Tokens pro Modellaufruf stammen aus dem
  [Transkript der Session](#logs-transkripte-und-workspaces). Ohne Log-Verzeichnis zeigt die Timeline nur die
  Agenten-Ereignisse (gekürzte Texte).
- Tokens und Kosten der Session meldet Claude Code am Ende jedes Turns; die Werte pro Modellaufruf bewertet Symphony
  mit derselben `model-costs.yml`.
- Symphony hält die Timeline nur, solange das Issue beansprucht ist (laufend, in der Warteschlange oder pausiert), und
  höchstens die letzten 2.000 Ereignisse. Nach einem Neustart oder nach `Done` ist sie weg; abgeschlossene Läufe stehen
  in den [Repository-Logs](#logs-und-statistiken).

| Endpunkt | Inhalt |
|---|---|
| `GET /` | Dashboard |
| `GET /agent?id=<identifier>` | Agent-Detailansicht (Execution Trace) |
| `GET /logs` | Statistik- und Analyse-Seite; Filter in der URL: `?period=30d` (`today`, `yesterday`, `7d`, `14d`, `30d`, `90d`, `month`, `last_month`, `all` oder `custom&from=YYYY-MM-DD&to=YYYY-MM-DD`), `&repo=owner/name`, `&model=<id>` |
| `GET /api/v1/history` | Gesamtstatistik als JSON (ohne Zeitraum), optional mit `?repo=owner/name`; speist den Logs-Drawer im Dashboard |
| `GET /api/v1/history/analytics?from=&to=&repo=&model=&tz=` | serverseitig aggregierte Analysen für einen Zeitraum (`from` inklusive, `to` exklusive, ISO-Zeitpunkte, beide optional): Kennzahlen mit Vorperiode, Zeitreihen, Modelle, Repositories, Issues, Ergebnisse, Laufzeiten, Tools und Integrationen (`tools`), Heatmap, Top-Läufe, Auffälligkeiten. `tz` (IANA-Zone) bestimmt Buckets, Wochentage und Stunden |
| `GET /api/v1/history/entries?from=&to=&repo=&issue=&event=&result=&order=desc&limit=200` | Log-Einträge eines Zeitraums, gefiltert und sortiert (höchstens 1.000) |
| `GET /api/v1/history/raw?repo=owner/name` | die `.log`-Datei eines Repositorys als Text |
| `GET /api/v1/state` | Gesamtzustand als JSON: laufende Agenten (mit `role`), Warteschlange (`retrying[]` mit `kind` und, bei Session-Limits, `limit`), Summen, Gesundheit, `controls.retry` (ob der Neustart erlaubt ist) |
| `GET /api/v1/<identifier>` | Details zu einem Issue: Titel, Rolle, Workspace, Versuche, Sessions (`sessions`), Tokens und Kosten pro Modell (`usage_by_model`), letzte Ereignisse, letzter Fehler, letzter Entry-Check (`last_check`), `controls.retry` |
| `GET /api/v1/<identifier>/timeline?after=<seq>` | Timeline des Issues: Lifecycle, Phasenwechsel und Agenten-Ereignisse mit fortlaufender `seq`; `after` liefert nur neuere |
| `GET /api/v1/<identifier>/transcript?run=<run>&from=<offset>` | Transkript einer Session (ohne `run` die neueste), aufbereitet als Prompts, Modellaufrufe, Tool-Ergebnisse; ab Byte-Offset `from`, weiter mit `next_offset`. Mit `&format=raw` die JSONL-Datei |
| `POST /api/v1/refresh` | sofort abfragen und abgleichen |
| `POST /api/v1/<identifier>/retry` | einen wartenden (Wiederholungs-Warteschlange, auch Session-Limit) oder pausierten Worker sofort neu starten. Antwort `202` mit `queued`, `issue_identifier` und `previous` (`retrying` oder `paused`). Fehler: `404` (Issue unbekannt), `409` (`running`: läuft gerade; `not_waiting`: wartet auf nichts; `stopping`: Symphony fährt herunter), `403` (`control_disabled` bei einer Nicht-Loopback-Adresse ohne `SYMPHONY_ALLOW_REMOTE_CONTROL=true`; `forbidden_origin` bei Cross-Origin-Anfragen und, bei einer Nicht-Loopback-Adresse, auch ohne `Origin`-Header) |

```bash
curl -s http://127.0.0.1:4000/api/v1/state
curl -s http://127.0.0.1:4000/api/v1/cooolinho%2Ftrainingsstunden-portal%2312   # / als %2F, # als %23
curl -s -X POST http://127.0.0.1:4000/api/v1/refresh
curl -s -X POST http://127.0.0.1:4000/api/v1/cooolinho%2Ftrainingsstunden-portal%2312/retry
```

Der Neustart-Endpunkt und die Buttons **Retry now** und **Resume now** funktionieren immer, solange der Server auf einer
Loopback-Adresse (`127.0.0.1`, `::1`, `localhost`) lauscht. Bei einer anderen Adresse (`SYMPHONY_HOST=0.0.0.0`, etwa im
Container hinter Traefik) antwortet die API mit `control_disabled`, und Dashboard und Agent-Seite zeigen statt der Buttons
einen Hinweis. Mit `SYMPHONY_ALLOW_REMOTE_CONTROL=true` ist der Neustart auch dort möglich, aber nur mit einem
`Origin`-Header, der zum `Host` passt (Schutz gegen CSRF, weil der Browser die Zugangsdaten des Proxys bei jeder Anfrage
mitschickt). Der Browser setzt ihn selbst; per `curl` über den Proxy gibst du ihn mit:

```bash
curl -s -X POST -u <user> -H 'Origin: https://<domain>' https://<domain>/api/v1/cooolinho%2Ftrainingsstunden-portal%2312/retry
```

Ob der Neustart erlaubt ist, steht in `GET /api/v1/state` und `GET /api/v1/<identifier>` unter `controls.retry`. Der Neustart
umgeht nur die Wartezeit: Ob das Issue wirklich startet, prüft Symphony wie bei jedem Retry erneut (aktive Spalte,
Konfiguration, freier Slot).

## Logs, Transkripte und Workspaces

| Was | Wo |
|---|---|
| Laufende Logs (`key=value`) | Terminal (stderr). Zusätzlich in eine Datei mit `--log-file <pfad>`, ausführlicher mit `--log-level debug`. |
| Log pro Repository: was wann bearbeitet wurde, mit Tokens, Modell, Kosten und Agentenzeit | `~/.local/state/symphony/repositories/<owner>_<repo>.log`, siehe [Logs und Statistiken](#logs-und-statistiken) |
| Transkript jeder Session (alle Agenten-Nachrichten als JSON-Zeilen `{ at, message }`, dazu der Prompt jedes Turns als `{ at, prompt: { turn, text } }`) | `~/.local/state/symphony/sessions/<workspace>/<zeit>.jsonl`. Einen anderen Ort wählst du mit `--log-dir <ordner>`. Die [Agent-Detailansicht](#agent-detailansicht-execution-trace) zeigt es aufbereitet. |
| Claude-Code-Session ansehen | im Workspace `claude --resume <thread-id>`. Die ID steht im Log als `thread_id` und in der API (`/api/v1/<identifier>`). |
| Workspaces | `~/symphony-workspaces/`. Sie werden bei `Done` gelöscht; andere kannst du gefahrlos von Hand löschen, wenn kein Agent darin läuft. |

## Logs und Statistiken

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
| `run_started` | Ein Agent beginnt mit einem Issue: Zeitpunkt, Issue, Titel, Spalte, Versuch, gewünschtes Modell (aus dem Label `Model: …`, sonst `CLAUDE_MODEL`) und gewünschter Effort (aus dem Label `Effort: …`, sonst `CLAUDE_EFFORT`). |
| `run_finished` | Ein Lauf endet. Erfasst werden das Ergebnis (`handed_off` = übergeben, `continuing` = noch aktiv, `failed`, `session_limit`, `stopped`, `stalled`, `shutdown`) und die Spalte danach. Dazu kommen Turns, das meistgenutzte Modell, Tokens (Input, Output, Cache), geschätzte Kosten und Agentenzeit. Die Felder `repo_*` sind die laufenden Summen des Repositorys. |
| `model_usage` | Tokens und Kosten eines Laufs pro Modell. Arbeitet Claude Code intern mit einem zweiten Modell, gibt es eine zweite Zeile. |
| `issue_paused` | Ein Issue wurde nach seinen Fortsetzungs-Sessions pausiert. |
| `session_limit_wait` | Die Session-Limit-Retries sind aufgebraucht: Der Worker wartet bis zum Reset des Limits (`retry_at` = Reset + 1 Minute) und macht dann weiter. Felder u. a. `window`, `resets_at`, `retry_at`, `hits`, `max_retries`, `source`. |
| `worker_restarted` | Ein wartender oder pausierter Worker wurde über **Retry now** / **Resume now** bzw. die API neu gestartet (`previous` = `retrying` oder `paused`). |
| `workspace_removed` | Der Workspace eines Issues in `Done` wurde gelöscht. |

Die **Statistik-Seite** (`/logs`, Button *Logs* im Dashboard) wertet diese Dateien aus. Oben steht ein globaler
Filter: **Zeitraum** (Heute, Gestern, letzte 7/14/30/90 Tage, dieser/letzter Monat, alles oder ein eigener
Datumsbereich), **Repository** und **Modell**. Er gilt für alle Abschnitte und steht in der URL. Ein Klick auf ein
Modell oder Repository in den Balkendiagrammen setzt diesen Filter, ein Klick auf einen Balken im Aktivitätsdiagramm
zoomt in den Zeitraum. Die Seite zeigt:

- **Kennzahlen**: Läufe, Issues, Tokens, geschätzte Kosten, Agentenzeit, durchschnittliche Laufzeit, Kosten und
  Tokens pro Lauf, erfolgreiche und fehlgeschlagene Läufe, Retry-Rate, pausierte Issues. Dazu der Vergleich mit der
  gleich langen Vorperiode, aber nur, wenn die Logs diese Vorperiode vollständig abdecken.
- **Zeitreihen** für Läufe, Tokens, Kosten und Agentenzeit. Die Granularität passt sich an: stündlich bis 2 Tage,
  täglich bis ~3 Monate, wöchentlich bis 2 Jahre, sonst monatlich. Dazu Kosten pro Bucket oder kumuliert und Tokens
  gestapelt nach Input, Output und Cache.
- **Modelle**: Vergleich nach Kosten, Läufen, Tokens, Kosten/Lauf, Tokens/Lauf oder Agentenzeit, plus eine
  Effizienztabelle (Kosten pro 1M Tokens, Output/Input-Verhältnis). Mit Modellfilter zählen Tokens und Kosten nur
  dieses Modell.
- **Repositories**: Vergleich, Aktivität über die Zeit (die drei aktivsten plus „Other“) und eine Tabelle mit
  letzter Aktivität.
- **Ergebnisse** der Läufe so, wie sie geloggt sind (`handed_off`/`continuing` = erfolgreich, `failed`/`stalled` =
  fehlgeschlagen, `stopped`/`shutdown` = gestoppt). Ein Lauf gilt als *Retry*, wenn der vorige Lauf desselben Issues
  fehlgeschlagen ist.
- **Laufzeiten**: Durchschnitt, Median (ab 3 Läufen), p90/p95 (ab 20 Läufen), kürzester und längster Lauf,
  Verteilung; eine **Heatmap** der Startzeiten nach Wochentag und Stunde.
- **Tools**: Tool-Aufrufe im Zeitraum, Läufe mit Aufrufen, Aufrufe pro Lauf, die meistgenutzten Tools (eingebaute wie
  `Bash` oder `Edit` und MCP-Tools als `server · tool`) und die geladenen Skills.
- **Laravel Boost & integrations**: pro Integration die Läufe auf Projekten, die sie nutzen, wie oft sie bereitstand
  und wie oft der Agent sie tatsächlich genutzt hat (Anteil an den bereitstehenden Läufen), die Aufrufe und die
  meistgenutzten Boost-Tools und -Skills. Guidelines gehören zu jeder bereitstehenden Session und zählen nicht als
  Aufruf. Tool-Aufrufe stehen erst in den Logs, seit Symphony sie aufzeichnet; ältere Läufe zählen als Läufe ohne
  Aufrufe.
- **Top-Läufe** nach Kosten, Tokens und Dauer, die meist wiederholten Issues und **Needs attention**: Läufe mit
  mindestens dem 3-fachen Durchschnitt des Zeitraums (ab 5 Läufen) sowie Issues mit mindestens 3 fehlgeschlagenen
  oder wiederholten Läufen.
- **Issues**, sortierbar (teuerste, meiste Tokens, längste Laufzeit, meiste Läufe, neueste, zuletzt beendet,
  fehlgeschlagen), und das **Log** des Zeitraums mit Filtern nach Issue, Ereignis und Ergebnis. Das Log lädt
  getrennt: Schlägt es fehl, bleiben die Statistiken sichtbar und das Log lässt sich einzeln neu laden. Bei einem
  einzelnen Repository gibt es einen Link auf die rohe `.log`-Datei.

Alle Zahlen kommen aus den Logs; die Kosten rechnet die Seite wie bisher mit der aktuellen `model-costs.yml`.

## Kosten schätzen mit `model-costs.yml`

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

## Mehrere Repositories

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

- **Eine Instanz pro Board:** Zwei Instanzen auf demselben Board würden dasselbe Issue im selben Ordner bearbeiten
  (parallele Git-Befehle, `composer install`, zwei Agenten auf einem Branch). Deshalb legt Symphony vor jedem Lauf
  die Datei `~/symphony-workspaces/<Ordnername>.lock` an, neben dem Klon, sodass `git status` sauber bleibt. Hält eine
  andere Instanz das Lock (laufender Prozess oder anderer Rechner), startet Symphony weder Hooks noch Agent, warnt im
  Log mit pid und Host des Halters und versucht es im nächsten Poll erneut. Das Lock eines beendeten Prozesses auf
  demselben Rechner übernimmt Symphony selbst. Beim Löschen des Workspaces verschwindet auch das Lock. Über mehrere
  Rechner hinweg gibt es nur diese Sperre, keine verteilte Abstimmung.

## Konfiguration anpassen

Die häufigsten Stellschrauben in der `WORKFLOW.md`. Alle Optionen beschreibt
[configuration.md](configuration.md).

| Einstellung | Wirkung |
|---|---|
| `agent.max_concurrent_agents` | wie viele Agenten gleichzeitig laufen (Standard hier: 2) |
| `agent.max_concurrent_agents_by_state` | Grenze pro Spalte, z. B. `{ "In progress": 1 }` |
| `agent.max_turns` | Turns pro Session, bevor Symphony den Stand neu bewertet |
| `agent.max_continuations` | Fortsetzungs-Sessions pro Issue (inklusive Rollenwechsel), danach Pause |
| `roles` | Rollen pro Spalte: Spalten, erlaubte Zielspalten (`may_move_to`), `read_only`, `max_turns`, Modell |
| `checks` | Skripte, die bestehen müssen, bevor eine Karte in eine Spalte darf (`on_enter`), und ihr Zeitlimit |
| `workspace.cleanup_terminal` | Workspaces bei `Done` löschen (Standard) oder behalten |
| `claude.max_budget_usd` | Kostenobergrenze pro Session |
| `claude.effort` | Denkaufwand: `low` … `max`. Kommt aus `CLAUDE_EFFORT`; ein Label `Effort: …` am Issue hat Vorrang, siehe [Effort pro Issue wählen](#effort-pro-issue-wählen) |
| `claude.allowed_tools` | Aktionen, die immer erlaubt sind, z. B. `"Bash(npm test:*)"` |
| `claude.plugins`, `claude.skills` | Plugin-Ordner für alle Sessions (Standard: `./.claude`) und welche Skills aktiv sind (`all`) |
| `laravel.*` | Laravel Boost: `boost: auto` oder `off`, PHP- und Composer-Befehl, Umgebung für Boost (`env`, Standard `APP_ENV: local`) und Agent (`agent_env`), Tool-Sperren (`allow_tinker`, `deny_tools`) |
| `tracker.required_labels` | nur Issues mit diesen Labels bearbeiten, z. B. `[symphony]` |
| `hooks.*` | Shell-Skripte rund um jeden Lauf, z. B. Abhängigkeiten installieren |
| Text unterhalb der Front Matter | der Prompt, ein Liquid-Template mit `issue`, `attempt` und `role` |

## Sicherheit

- **Berechtigungen:** Claude Code läuft im Modus `auto`. Ein Klassifikator erlaubt normale Entwicklungsarbeit und
  blockiert Riskantes. Fragt Claude Code trotzdem nach, antwortet Symphony mit *nein*
  (`on_permission_request: deny`), denn es schaut niemand zu. `git push` ist ausdrücklich erlaubt.
- **Token:** Der GitHub-Token wird aus der Umgebung des Agenten und der Hooks entfernt. Status, Kommentare und Pull
  Requests laufen über Tools, die Symphony selbst ausführt.
- **Grenzen:** Der Agent läuft als dein Linux-Benutzer. Er könnte grundsätzlich Dateien lesen, die du lesen kannst,
  etwa die `.env`, sofern Klassifikator oder Sandbox es nicht verhindern. Issue-Texte sind fremde Eingaben. Bearbeite
  nur Boards, deren Issues du vertraust. Für mehr Isolation: `claude.sandbox` aktivieren oder Symphony unter einem
  eigenen Benutzer, in einem Container ([docker.md](docker.md)) oder einer VM betreiben. Details: [agent-claude.md](agent-claude.md).
- **Dashboard:** Das Dashboard hat keine eigene Anmeldung. Eine Nicht-Loopback-Adresse (`SYMPHONY_HOST`, z. B.
  `0.0.0.0`) nur hinter einem Reverse-Proxy mit Anmeldung (BasicAuth, Forward-Auth) verwenden; Symphony warnt beim Start
  davor. `SYMPHONY_ALLOW_REMOTE_CONTROL=true` erlaubt dort den Neustart von Workern, mit Origin-Pflicht gegen CSRF.

## Kosten

Jede Session startet mit rund 30.000 Tokens Kontext (System-Prompt und Tool-Beschreibungen von Claude Code). Ein
minimaler Test-Turn mit `opus` kostete etwa 0,15 $. Echte Issues kosten je nach Umfang deutlich mehr. Das Dashboard
zeigt die geschätzten Kosten pro Agent und seit dem Start. Die Logs-Seite zeigt sie pro Repository, Modell, Issue und
Tag. Geschätzt wird mit der [`model-costs.yml`](#kosten-schätzen-mit-model-costsyml). Zum Begrenzen eignen sich:

- `claude.max_budget_usd` pro Session,
- ein günstigeres Modell für einfache Issues per Label, z. B. `Model: sonnet` oder `Model: haiku`,
- wenige parallele Agenten,
- `tracker.required_labels`, damit nur ausdrücklich markierte Issues bearbeitet werden.

## Laravel Boost

[Laravel Boost](https://laravel.com/docs/boost) gibt KI-Agenten Laravel-Wissen passend zu den installierten Paketen:
**Guidelines** (immer geladen), **Skills** (bei Bedarf geladen, z. B. `laravel-best-practices`, `testing-best-practices`,
`filament-development`) und einen **MCP-Server** mit Doku-Suche, Datenbankschema, Logs und Fehlern. Symphony nutzt Boost automatisch:

1. Nach dem `before_run`-Hook sucht Symphony im Workspace Laravel-Apps: im Root oder eine Ebene tiefer, z. B.
   `laravel/` im trainingsstunden-portal.
2. Steht `laravel/boost` in der `composer.json`, installiert Symphony bei Bedarf die Abhängigkeiten
   (`composer install`) und erzeugt Boosts Guidelines und Skills für Claude Code (`boost:install`). Danach prüft es,
   ob die Guidelines und alle Skills, die Boost in `boost.json` meldet, wirklich geschrieben wurden: `boost:install`
   endet auch dann mit Exit-Code 0, wenn das Schreiben scheitert. Fehlt etwas, warnt Symphony und erzeugt beim
   nächsten Versuch neu.
3. Die erzeugten Dateien trägt Symphony in `.git/info/exclude` ein. Versionierte Dateien, die Boost verändert hat,
   setzt es zurück. So landet nichts davon im Pull Request.
4. Die Session bekommt den MCP-Server `laravel-boost`, die Boost-Skills und Boosts Guidelines im System-Prompt.
   Der Prompt nennt die tatsächlich erzeugten Skills und die freigegebenen und gesperrten Tools.
5. Neu erzeugt wird nur, wenn sich `composer.lock`, `.ai/` oder die Boost-Version ändern.
6. Ob und wie der Agent Boost genutzt hat, zeigen Dashboard-Karte, Agent-Seite und Statistik-Seite (siehe
   [Dashboard und API](#dashboard-und-api) und [Logs und Statistiken](#logs-und-statistiken)).

Damit Artisan und Boost nie eine fremde Datenbank erreichen, legt `hooks/laravel-env.sh` im `after_create`-Hook für jede
Laravel-App eine eigene `.env` mit eigener SQLite-Datenbank an (`database/symphony.sqlite`, `CACHE_STORE=file`,
`BOOST_BROWSER_LOGS_WATCHER=false` u. a.). Eine vorhandene `.env` bleibt unangetastet, `.env` und die Datenbank landen in
`.git/info/exclude`, falls die App sie nicht selbst ignoriert:

```yaml
after_create: |
  set -e
  git clone --quiet "git@github.com:${SYMPHONY_ISSUE_REPOSITORY}.git" .
  bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"
```

Optional MySQL statt SQLite: Mit `SYMPHONY_LARAVEL_DB=mysql` in der Umgebung von Symphony legt `hooks/laravel-env.sh`
pro Workspace die Datenbanken `symphony_<key>` und `symphony_<key>_test` an (`<key>` = die ersten 12 Hex-Zeichen des
sha256 von `SYMPHONY_WORKSPACE_KEY`), setzt `DB_*` in `.env` und schreibt `.env.testing`. Im Hook `before_remove` löscht
`bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-db-drop.sh"` beide wieder. Variablen: `SYMPHONY_MYSQL_HOST` (Standard
`127.0.0.1`), `SYMPHONY_MYSQL_PORT` (`3306`), `SYMPHONY_MYSQL_USER` (Pflicht) und `SYMPHONY_MYSQL_PASSWORD` (wird nie
ausgegeben). Der MySQL-Benutzer wird auf `symphony\_%` beschränkt, das deckt auch `php artisan test --parallel` ab:

```sql
GRANT ALL PRIVILEGES ON `symphony\_%`.* TO 'symphony'@'localhost';
```

Voraussetzung: `phpunit.xml` darf `DB_DATABASE` nicht fest setzen, sonst gewinnt dessen Wert gegenüber `.env.testing` und
parallele Workspaces teilen sich eine Test-Datenbank. Details in [configuration.md](configuration.md).

Fehlt Boost in einem Laravel-Repository, legt `npm run repo-init` → *Laravel Boost* ein Issue an, das Boost per Pull
Request einführt. Klappt etwas nicht (kein PHP, `composer install` scheitert), läuft die Session ohne Boost weiter.
Die Warnung steht im Log. `npm run dry-run` zeigt, ob `php` und `composer` laufen.

Voraussetzungen und Grenzen:

- **PHP und Composer auf dem Host**, in den Versionen, die die Projekte verlangen. Eigene Pfade:
  `SYMPHONY_PHP=/usr/bin/php8.4` in der `.env`. Soll PHP später in einem Container laufen, zeigt `laravel.php` auf ein
  Wrapper-Script. Es bekommt den absoluten `artisan`-Pfad als erstes Argument und `SYMPHONY_WORKSPACE` in der
  Umgebung.
- **`APP_ENV=local`:** Boost läuft nur lokal. Symphony setzt `laravel.env` (Standard `APP_ENV: local`) für seine
  Composer- und `artisan`-Schritte und den MCP-Server, weil ein frischer Klon keine `.env` hat, aber nicht für die Shell
  des Agenten: Dort würde `APP_ENV=local` PHPUnits `APP_ENV=testing` überstimmen. Variablen für den Agenten gehören
  nach `laravel.agent_env` (Standard leer). Datenbank-Einstellungen gehören in die `.env` der App (siehe oben), nicht
  in `laravel.env`.
- **Boost-Tools:** Freigegeben sind nur die lesenden Tools (`application-info`, `browser-logs`,
  `database-connections`, `database-query` (nur lesend), `database-schema`, `get-absolute-url`, `last-error`,
  `read-log-entries`) und `search-docs` (schickt Anfragen und die Paketliste an boost.laravel.com). `tinker` führt
  beliebiges PHP aus und ist gesperrt, außer mit `laravel.allow_tinker: true`. `laravel.deny_tools` (Standard
  `[record-rule]`, schreibt `.ai/rules`) sperrt weitere Tools, z. B. `[search-docs, record-rule]`. Neue Tools späterer
  Boost-Versionen sind nicht vorab freigegeben.
- **Committete Boost-Dateien:** Liegt `boost.json` im Repository, verwaltet das Repository Boost selbst. Symphony
  erzeugt dann nichts und nutzt die committeten Dateien.
- **Sail:** Erkennt Boost Laravel Sail, verweisen seine Guidelines auf `vendor/bin/sail`. Symphony warnt dann, weil es
  PHP auf dem Host ausführt.

## Skills: wo gehören sie hin?

Faustregel: Wissen gehört dorthin, wo es versioniert wird und wo es gilt.

| Wissen | Ort | Warum |
|---|---|---|
| Framework-Wissen (Laravel, Livewire, Pest, Inertia …) | **Laravel Boost** im jeweiligen Repository, von Symphony erzeugt | passt zu den Versionen in `composer.lock`; Kopien in Symphony würden veralten |
| Domäne und Projekt („Rechnungen erstellen“, Mandanten-Scoping) | **Repository:** `.ai/skills/` und `.ai/guidelines/` (Laravel), sonst `.claude/skills/` | wird mit dem Code versioniert und im Pull Request geprüft; hilft auch dir lokal |
| Projektregeln und Fallen | **Repository:** `.ai/rules/`, über Boosts Tool `record-rule` oder den Skill `infer-conventions` | wird nach Dateipfad geladen und gilt für alle |
| Arbeitsweise über alle Repositories (PR-Stil, Commits, Prüfen ohne UI, Übergabe ans Board) | **Symphony:** `.claude/skills/` | gilt nur für Symphony-Agenten, in jedem Repository gleich |
| Aufgaben, die per Befehl im Issue starten (`/refactoring`, `/refactor-safely`, `/auto-code`) | **Symphony:** `.claude/skills/`, siehe [Befehle im Issue](#befehle-im-issue-refactoring) | einmal pflegen statt in jedem Repository; laufen nur unter Symphony |
| Persönliche Vorlieben | `~/.claude/` | lädt Symphony bewusst nicht |

Alles ins Symphony-Repository zu legen, wäre bequem, hat aber Nachteile. Diese Skills sähen nur Symphony-Agenten,
nicht du lokal. Sie hingen nicht an der Code-Version des Repositories. Und Boost-Skills lassen sich nur im Repository
überschreiben: Ein gleichnamiger Skill in `.ai/skills/` ersetzt den von Boost.

In Laravel-Repositories gehören eigene Skills nach `.ai/skills/<name>/SKILL.md`, nicht nach `.claude/skills/`. Boost
überschreibt `.claude/skills` beim Erzeugen, und `.ai/` funktioniert auch mit anderen Agenten (Cursor, Codex …).

Symphonys `.claude/` hat die Ordner `skills/`, `agents/`, `commands/` und `hooks/` und wird über
`claude.plugins: [./.claude]` geladen. Seine Skills heißen im Agenten `symphony:<name>`. Regeln für gute Skills stehen
in [.claude/README.md](../.claude/README.md).

## Repositories mit Docker-Setup (z. B. trainingsstunden-portal)

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

## Fehlerbehebung

| Symptom | Ursache und Lösung |
|---|---|
| `GitHub token lacks a required scope` | Dem Token fehlt `project`. Lösung: `gh auth refresh -s project`, oder einen klassischen Token mit `repo` und `project` erstellen. |
| `GitHub rejected the token (HTTP 401)` | Token falsch oder abgelaufen. `GITHUB_TOKEN` in der `.env` prüfen. |
| `Candidates in active states: 0` | Das Board ist leer, kein Issue steht in `Ready`, `In progress` oder `Agent review`, die Issues stammen aus einem anderen Repository als `GITHUB_REPOSITORY`, oder die Spaltennamen passen nicht zu `active_states`. |
| `↳ blocked by …` oder `↳ waiting for sub-issues …` im Dry Run | Das Issue wartet auf eine Abhängigkeit oder ein Sub-Issue. Es startet von selbst, sobald diese geschlossen sind, also meist nach dem Merge ihres Pull Requests. |
| `↳ issue is closed` | Geschlossene Issues werden nicht bearbeitet. |
| `project field "Status" is missing` | Das Board hat kein Single-Select-Feld `Status`. Den Namen des Feldes unter `tracker.provider.status_field` eintragen. |
| `after_create hook exited with code 128 … Permission denied (publickey)` | SSH-Zugriff auf GitHub fehlt. `ssh -T git@github.com` prüfen. |
| `after_create hook exited with code 128 … Remote branch develop not found` | `SYMPHONY_BASE_BRANCH` gilt für **alle** Repositories auf dem Board. Den Branch in jedem Repository anlegen oder das Repository aus `GITHUB_REPOSITORY` entfernen. |
| `before_run hook exited with code 128 … not a git repository` | Der Workspace enthält keinen Klon, weil `after_create` einen fehlgeschlagenen `git clone` übergangen hat (ohne `set -e` zählt nur die letzte Zeile des Hooks). Leere Workspaces bereitet Symphony beim nächsten Versuch selbst neu vor. Ist der Workspace nicht leer, aber kaputt, das Verzeichnis löschen. |
| Ein Agent fängt immer wieder von vorn an | Das Issue verlässt die aktiven Spalten nie, etwa weil die Übergabe-Spalte fehlt oder `set_status` scheitert (Warnung `agent tracker_tool` mit `set_status failed` im Log). Erst pausieren (`max_concurrent_agents: 0`), dann die Spalten bzw. den Prompt korrigieren. |
| Warnung `agent agent_error` (z. B. `authentication_failed`) oder `startup_failed` | Claude Code ist nicht angemeldet bzw. das Konto hat ein Problem. Einmal `claude` starten und `/login` ausführen, oder `ANTHROPIC_API_KEY` setzen. |
| `env file values ignored because the shell environment already sets them` | Die Variable ist auch in der Shell gesetzt, und die Shell gewinnt. `unset GITHUB_TOKEN` oder den Wert dort anpassen. |
| `unknown board column "…" (valid: …)` | Die `WORKFLOW.md` nennt eine Spalte, die es auf dem Board nicht gibt (Tippfehler in `active_states`, `terminal_states`, `roles.*.states`, `roles.*.may_move_to` oder `checks.on_enter`). Den Namen korrigieren; die Prüfung ist unabhängig von Groß-/Kleinschreibung und der Fehler verschwindet nach dem automatischen Neuladen. Der Dry Run zeigt ihn ebenfalls. |
| `dispatch validation failed` | Ein Fehler in der `WORKFLOW.md` oder `.env`. Die genaue Meldung steht im Log bzw. im Dashboard. |
| Warnung `issue paused: still active after its continuation sessions` | Der Agent hat das Issue nach `SYMPHONY_MAX_CONTINUATIONS` Fortsetzungen nicht abgeschlossen. Lies den letzten Kommentar und das Transkript, dann schreib einen Hinweis ins Issue (das setzt es fort) oder verschieb die Karte. |
| Meldung `You've hit your session limit` (Dashboard: *Session limit*) | Dein Claude-Abonnement hat sein Nutzungslimit erreicht. Symphony wiederholt bis zu `SYMPHONY_MAX_SESSION_LIMIT_RETRIES` Mal und wartet dann bis zum Reset, siehe [Session-Limit](#session-limit). Hast du Guthaben aufgeladen, hilft **Retry now**. Ein `ANTHROPIC_API_KEY` hat kein Session-Limit. |
| Ein Worker wartet länger als erwartet | Im Dashboard unter *Retrying* nach `retry at` und `resets` schauen. Beim Session-Limit ist das der Reset plus 1 Minute, bei unbekanntem Reset gilt der normale Backoff (bis 10 Minuten). Ein pausiertes Issue (*Paused*) hat keinen Termin: Es geht erst bei einer Änderung am Issue, einem höheren `max_continuations` oder per **Resume now** weiter. Nach einem Symphony-Neustart ist ein Warten vergessen. Sofort starten: **Retry now**. |
| Warnung `model label ignored` | Ein Model-Label ist unbekannt (Tippfehler), oder das Issue hat mehrere Model-Labels mit verschiedenen Modellen. Symphony nutzt dann `CLAUDE_MODEL`. Label korrigieren, `npm run dry-run` zeigt das Ergebnis. |
| Warnung `effort label ignored` | Ein Effort-Label ist unbekannt (Tippfehler, erlaubt sind `low`, `medium`, `high`, `xhigh`, `max`), oder das Issue hat mehrere Effort-Labels mit verschiedenen Stufen. Symphony nutzt dann den Effort der Rolle oder `CLAUDE_EFFORT`. Label korrigieren, `npm run dry-run` zeigt das Ergebnis. |
| Session scheitert gleich zu Beginn mit einem Modellfehler | Das Label nennt eine Version, die es nicht gibt, z. B. `Model: claude-opus-9-9`. Symphony wiederholt den Lauf mit Wartezeit. Label korrigieren. |
| `repo-init` meldet `HTTP 404` oder `HTTP 403` | Das Repository in `GITHUB_REPOSITORY` ist falsch geschrieben, oder der Token darf keine Labels oder Issues anlegen bzw. keine Dateien lesen. Klassischer Token: Scope `repo`, Fine-grained Token: *Issues: Read and write* und *Contents: Read*. |
| Warnung `Laravel Boost skipped: composer install failed` | PHP- oder Erweiterungsversion passt nicht zu `composer.lock`, oder Composer erreicht Packagist nicht. Die Ausgabe steht im Log. Passendes PHP installieren und `SYMPHONY_PHP` setzen. |
| Warnung `Laravel Boost skipped: boost:install failed` mit `Command "boost:install" is not defined` | Boost ist nicht aktiv, meist weil `APP_ENV` nicht `local` ist. `laravel.env` prüfen; `BOOST_ENABLED=false` in einer committeten Konfiguration schaltet Boost ganz ab. |
| Warnung `an MCP server Symphony added is not connected` | `php artisan boost:mcp` startet nicht. Im Workspace `APP_ENV=local php artisan boost:mcp` von Hand ausführen und die Fehlermeldung lesen. |
| Dry Run: `php (not found)` | PHP ist nicht installiert oder nicht im `PATH`. Laravel-Workspaces laufen dann ohne Boost. `SYMPHONY_PHP` auf den Pfad setzen. |
| `candidate fetch failed … timed out` oder `HTTP 503` | GitHubs GraphQL-API ist kurzzeitig gestört. Lesende Abfragen wiederholt Symphony automatisch, sonst einfach den nächsten Tick abwarten. Laufende Agenten sind nicht betroffen. |

## Laravel-Repositories

Damit Symphony-Agenten und Laravel Boost in einem Laravel-Repository gut arbeiten, muss das Repository einige
Konventionen einhalten: `AGENTS.md` und `.ai/`, die Composer-Skripte `test`, `lint` und `analyse`, ein vollständiges
`.env.example`, eine passende `phpunit.xml`, Boost in `require-dev` und die Repository-Einstellungen auf GitHub. Die
Anleitung (auf Englisch) steht in [laravel-repositories.md](laravel-repositories.md).

← [Dokumentation](index.md) · Zurück: [Getting Started](getting-started.md)
