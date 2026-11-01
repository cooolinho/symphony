# Konzept: Glass-Dashboard, Team-Ansicht und Symphony-Brain

Status: Mockup abgenommen am 2026-10-27 · Version des Konzepts: 1

Mockup (sechs Ansichten): [symphony-glass-dashboard.html](symphony-glass-dashboard.html)

## Ziel

Das Dashboard wird komplett neu gestaltet und um ein gemeinsames Gedächtnis der Agents erweitert:

1. **Glass-Design und Navigation:** ein dunkles Glas-Design und eine Navigation mit fünf Seiten statt drei lose
   verlinkter Seiten.
2. **Sichtbarkeit:** Ich sehe auf einen Blick, wie es dem Host geht, welche Teams gerade arbeiten, wann ein
   Session-Limit droht und was sich im Code und im Gedächtnis geändert hat.
3. **Team-Ansicht:** Jedes Issue bekommt eine Team-Ansicht. Jedes Mitglied (Rolle, Subagent) ist sichtbar aktiv,
   wenn es arbeitet.
4. **Symphony-Brain:** ein Obsidian-Vault auf dem Server, den die Agents über eigene Tools lesen und beschreiben und
   den der Mensch im Browser über einen Obsidian-Container ansieht und pflegt. Es gibt kein Abo und keinen Sync, alles
   läuft im LAN.

Zielgruppe ist der Betreiber der Instanz (eine Person, Heimnetz, Desktop zuerst).

## Ausgangslage (Stand v1.0.1)

- Das Dashboard besteht aus drei Seiten (`/`, `/agent?id=`, `/logs`) in `src/http/*.ts`, zusammen etwa 4.600 Zeilen
  Inline-HTML/JS:
  - dunkles „Control-Center“-Theme in `src/http/styles.ts`
  - Polling von `/api/v1/state` alle 2 s (`dashboard.ts:1442`)
  - die Topbar ist dreimal kopiert (`dashboard.ts:221`, `agent-page.ts:227`, `logs-page.ts:98`)
- **Team:** Pro Issue läuft genau eine Session (`#running` je Issue, `orchestrator.ts:637`). Das „Team“ sind die
  Pipeline-Rollen (`stages[]`, `orchestrator/pipeline.ts:32-50`). Claude-Subagents werden nur gezählt
  (`agent_calls`, `claude.ts:622-626`), ihr Status wird nicht verfolgt.
- **Fehlende Daten:**
  - Es gibt keine System-Metriken; nur `checks/laravel.sh` liest `/proc/loadavg`.
  - Es gibt keinen Context-Füllstand.
  - Limits werden erst erkannt, wenn sie eintreten (`agent/rate-limit.ts`). Von den `rate_limit_event`s bleibt nur
    das letzte erhalten (`claude.ts:476`, `orchestrator.ts:660`).
  - Es gibt keine Changes-Ansicht: `workspace/changes.ts` liefert nur Pfade für die Gates, und `changed_files` aus dem
    Implementierungsergebnis geht in `stage-history.ts:380` verloren.
- **Tasks:** Die Daten sind vorhanden (`queue[]`, `blocked[]`, `PlanReasonCode` in `orchestrator/dispatch-plan.ts`),
  stehen heute aber auf dem Dashboard.
- **Agent-Tools** laufen in-process über `createSdkMcpServer` (`claude.ts:365`). Weitere Session-Bausteine kommen über
  `SessionExtensions` (`integrations/types.ts`).
- **Tests:** Die HTTP-Tests prüfen Quelltext-Strings der Seiten (`test/http.test.ts`,
  `test/stage-results-dashboard.test.ts`, `test/repositories-dashboard.test.ts`, `test/gate-run.test.ts`).

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Look | Dunkles Glas: Navy-Grund (`#070b16`) mit weichen Aurora-Farbflächen, Panels mit `backdrop-filter: blur()`, Neon-Akzente. Keine helle Variante. |
| Farben | Rollenfarben statt Anbieterfarben: Analyst `#38bdf8`, Architect `#a78bfa`, Developer `#34d399`, Tester `#fbbf24`, Docs `#cbd5e1`, Reviewer `#f472b6`, Security `#fb923c`, Symphony `#94a3b8`. Status-Töne: grün läuft, amber Warnung, rot Fehler, grau wartet. |
| Navigation | Übersicht · Changes · Tasks · Brain · Statistik. Die Team-Ansicht ist die Detailseite eines Issues. |
| Team-Ansicht | „Bühne + Partitur“ (siehe E3) |
| Changes | Code und Brain in einem Feed, per Filter trennbar |
| Brain-Ablage | ein Vault auf dem Server; Agents greifen nur über Symphony-Tools zu |
| Brain-Sicht | Obsidian-Desktop als Container im Browser (`linuxserver/obsidian`) hinter Traefik. Kein Obsidian Sync, kein Headless, kein Syncthing. |
| Schreibrecht | Agents schreiben, neue Notizen starten mit `status: candidate`. Der Mensch (oder später der Gärtner) befördert zu `approved`. |
| Budgets | Abo-Limits (5-h- und Wochenfenster) mit Burn-Rate und ETA **und** Context-Füllstand je Session |
| UI-Sprache | Deutsch. Fachbegriffe wie Changes, Tasks und Review bleiben Englisch, die Doku unter `docs/` bleibt Englisch. |
| GPU | Der Server hat keine GPU. Die GPU-Karte ist vorbereitet, aber abgeschaltet (E2-1). |
| Vault-Zuschnitt | ein Vault für alle Repositories, ein Ordner je Repo unter `Repos/` |
| Obsidian-Zugang | reines HTTP im LAN reicht, kein eigenes Zertifikat |
| Technik | framework-frei und ohne Build-Schritt wie bisher. Der Client baut den DOM mit `el()` (kein `innerHTML` für Daten). Polling bleibt vorerst; SSE ist eine eigene Anforderung (E1-6). |

## Nicht-Ziele

- Echte Parallelität mehrerer Rollen an einem Issue. Die Team-Ansicht zeigt die Staffel so, wie sie heute läuft; ein
  Orchester mit gleichzeitigen Rollen wäre ein Orchestrator-Umbau mit eigenem Konzept.
- Unterscheidung nach Anbietern (Grok, Claude, …) wie im Brain-Monitor-Screenshot.
- Helles Theme oder Theme-Umschalter.
- Obsidian Sync, Obsidian Headless, Syncthing oder Git-Sync auf Endgeräte.
- Eigene Authentifizierung im Dashboard. Es bleibt bei Traefik (Basic-Auth-Middleware) und dem LAN.
- Automatisches Drosseln des Dispatchers bei knappem Limit (nur Warnung, siehe offene Frage 9).

## Datenobjekte

| Objekt | Inhalt | Quelle / Ablage |
|---|---|---|
| `SystemSample` | Zeit, CPU %, RAM belegt/gesamt, Disk belegt/gesamt je Volume, Load 1/5/15, optional GPU | neuer Collector, Ringpuffer im Speicher (1 h bei 10-s-Takt) |
| `ContextSnapshot` | Run, Modell, Fenstergröße, belegte Tokens (Input + Cache read + Cache write des letzten Model-Calls), Prozent, Anzahl Auto-Compacts | aus SDK-Nachrichten in `claude.ts`, im `RunningEntry` |
| `RateLimitEvent` | `at` (ISO), `run_id`, `issue`, `role`, `model`, `rate_limit_info` (SDK object) | JSONL `<logDir>/budget/rate-limits.jsonl`, rotated after 30 days at startup and once daily |
| `BudgetForecast` | Fenster, Verbrauch im rollenden Fenster, Burn-Rate, geschätzte Grenze, ETA, Reset | berechnet aus History + Events |
| `SubagentRun` | `tool_use_id`, Typ, Beschreibung, Start, Ende, Status, Tokens | aus SDK-Nachrichten (`parent_tool_use_id`) |
| `TeamView` | Sitze (Rolle, Status, Verdict, Dauer, Modell), aktiver Sitz mit Aktion und Context, Subagents, Partitur-Blöcke, Übergaben | `stages[]`, `running`, Timeline |
| `ChangeEntry` | Typ `code`/`brain`, Zeit, Repo, Issue, Rolle, Titel, Dateien mit +/−, PR-Status bzw. Notiz, Diff-Auszug, Status | Workspace-Git, Tracker, Vault-Git |
| `BrainNote` | Pfad, Frontmatter (`type`, `status`, `repo`, `issue`, `role`, `run`, `created`, `updated`, `sources`), Links | Markdown-Datei im Vault |
| `BrainAccess` | Zeit, Run, Issue, Rolle, Operation (`read`/`search`/`write`/`append`/`list`), Pfad oder Suchbegriff, Zweck, Ergebnis (`ok`/`rejected`), Hash vorher/nachher | JSONL `<logDir>/brain/access.jsonl` |
| `BrainClash` | Pfad, beide Runs, Zeiten, Grund (`hash_mismatch` / `window`), Status offen/gelöst | aus dem Access-Log abgeleitet |

## Abläufe

**Agent liest und schreibt im Brain**

1. Die Rolle hat `brain: read` oder `brain: write` (E7-5).
2. Der Prompt-Abschnitt sagt: Zu Beginn liest der Agent `Repos/<repo>/index.md` und sucht nach dem Thema.
3. Jeder Aufruf trägt einen `purpose`.
4. `brain_write` schickt den `base_hash` der gelesenen Fassung mit. Hat sich die Datei seitdem geändert, oder hat ein
   anderer Run sie innerhalb des Schutzfensters geschrieben, wird abgewiesen: Der Agent bekommt die aktuelle Fassung
   zurück, das Dashboard zeigt einen Clash.
5. Bei Erfolg schreibt Symphony die Datei, committet sie im Vault-Git (Autor = Rolle, Nachricht mit Issue und Run) und
   protokolliert den Zugriff.

**Kandidat wird Wissen**

Neue Notizen landen mit `status: candidate`, meist in `Inbox/`. Der Mensch befördert sie entweder auf der Brain-Seite
(Symphony setzt `status: approved` und verschiebt sie an den Zielpfad) oder in Obsidian (Frontmatter ändern). Die
Brain-Suche liefert `approved` vor `candidate` und `deprecated` nie.

**Issue-Zusammenfassung**

Nach dem Merge schreibt Symphony selbst, ohne Agent, `Issues/<repo>/<nr>.md` mit `status: approved` aus den
gespeicherten Stage-Ergebnissen.

**Limit-Prognose**

Jedes `rate_limit_event` wird gespeichert. Aus dem Token-Verbrauch im rollenden 5-h- und 7-Tage-Fenster ergibt sich die
Burn-Rate (gleitend über die letzten 30 min). Das SDK liefert die Auslastung: Je Fenster steht sie in
`unifiedWindows` des neuesten Events, und die Grenze ergibt sich aus Verbrauch / Auslastung. Nur ohne SDK-Wert
(Fenster fehlt, Event `rejected`) ist die Kalibrierung aus dem Verbrauch zum Zeitpunkt früherer
`session_limit`-Treffer der Fallback.
ETA = (Grenze − Verbrauch) / Burn-Rate, angezeigt nur, wenn sie vor dem Reset liegt.

## Funktionsbereiche

Jede Anforderung ist mit `E<n>-<m>` nummeriert und einzeln umsetzbar. Akzeptanzkriterien stehen darunter. Tests
gehören in die Anforderung, die den Code ändert.

### E1 Glass-Designsystem und App-Shell (Fundament)

**E1-1 Design-Tokens und Basis-Komponenten**

Neues Modul `src/http/ui/tokens.ts` ersetzt `BASE_CSS`. Es definiert:

- Tokens für Glas (`.g`, `.gi`), Rollenfarben und Status-Töne
- Typo: System-Schriftstapel und Monospace für Zahlen
- Fokus-Ring
- `prefers-reduced-motion` (stoppt alle Animationen)
- `prefers-reduced-transparency` (Panels deckend `#111a2c`, ohne Blur)

Abnahme:
- keine externen Requests (keine Web-Fonts von Dritten)
- Fließtext mindestens 4.5:1 Kontrast auf Glas
- Touch-Ziele mindestens 44 px

**E1-2 Client-Bausteine**

`BASE_JS` (`styles.ts:165`) bekommt Bausteine für:

- Karte, Kennzahl-Kachel, Fortschrittsbalken mit Prognose-Schraffur
- Ring-Gauge (conic-gradient), Sparkline (SVG)
- Avatar mit Zuständen fertig, spielt (Puls-Ring und Equalizer), wartet, Rückgabe, übersprungen
- Chip und Filter-Chip

Abnahme:
- Alle Bausteine erzeugen DOM über `el()`, ohne `innerHTML` für Daten.
- Je Baustein gibt es einen Test mit dem Fake-DOM.

**E1-3 Layout und Navigation**

`src/http/ui/layout.ts` liefert die Seitenhülle:

- Aurora-Hintergrund
- schwebende Glas-Kopfleiste mit Logo, LIVE-Status, Pill-Navigation, 5-h-Chip, Version und Uhr
- Brotkrumen für Unterseiten

Abnahme:
- Alle Seiten nutzen dieselbe Hülle; die drei kopierten Topbars sind entfernt.
- Der aktive Punkt trägt `aria-current="page"`.
- Bei 390 px Breite scrollt die Navigation horizontal in ihrem Rahmen, nicht die Seite.

**E1-4 Routen**

| Route | Seite |
|---|---|
| `/` | Übersicht |
| `/changes` | Changes |
| `/tasks` | Tasks |
| `/brain` | Brain |
| `/stats` | Statistik |
| `/issue?id=` | Team-Ansicht |

Abnahme:
- `/logs` → 301 auf `/stats` und `/agent?id=` → 301 auf `/issue?id=`, mit Test.
- Die Loopback- und Host-Prüfung in `server.ts` gilt für alle neuen Routen.

**E1-5 Tests auf Verhalten umstellen**

Die Quelltext-Asserts in `test/http.test.ts` und den Dashboard-Tests werden durch Tests ersetzt, die
- Seitenfunktionen im `vm` mit Fake-DOM ausführen,
- die Routen über den echten Server prüfen,
- weiterhin jedes Inline-`<script>` parsen.

Abnahme: Kein Test hängt mehr an exakten JS-Zeilen oder an der Einrückung.

**E1-6 Live-Updates per SSE**

- `GET /api/v1/events` sendet bei `orchestrator.onChange` (`orchestrator.ts:1187`) ein Ereignis.
- Die Seiten laden dann gezielt nach; Polling bleibt als Rückfall.

Abnahme:
- Ohne SSE-Verbindung funktioniert alles wie mit Polling.
- Höchstens 1 Ereignis je 500 ms.

### E2 Übersicht

**E2-1 System-Collector**

`src/system/metrics.ts` liest alle 10 s:

- `/proc/stat` (CPU-Delta), `/proc/meminfo`, `/proc/loadavg`
- `fs.statfs` für das State- und das Workspace-Volume
- GPU: vorbereitet, aber abgeschaltet. Der Collector hat eine GPU-Quelle (`nvidia-smi`), die nur mit
  `system.gpu: true` in `WORKFLOW.md` läuft; Standard ist `false`, der Server hat keine GPU.

Ringpuffer 1 h, `GET /api/v1/system` mit aktuellem Wert und Verlauf. Die Antwort hat ein Feld `gpu`, das bei
abgeschalteter GPU `null` ist.

Abnahme:
- Ohne `/proc` (Tests) liefert der Collector `null`-Werte statt Fehlern.
- Mit `system.gpu: false` wird `nvidia-smi` nie aufgerufen, und die GPU-Karte fehlt.
- Mit `system.gpu: true` und einer gefälschten `nvidia-smi`-Ausgabe (Test) erscheinen Auslastung, Speicher und
  Temperatur.

**E2-2 System-Karten**

Karten für CPU, RAM, Disk, Load, Agent-Slots (belegt/gesamt, Queue) und GitHub-API (Restbudget, letzter Poll), je mit
Wert, Balken und Sparkline.

Abnahme: Werte stimmen mit `/api/v1/system` und `/api/v1/state` überein; Ampelfarbe ab 80 % amber, ab 95 % rot.

**E2-3 Teams live**

Eine Zeile je laufendem Issue:

- Nummer, Titel, Repo, Spalte, Runde
- die Rollen-Avatare aus `stages[]`
- aktive Rolle mit Equalizer und Aktion (aus `last_event`/`last_message`)
- Context-Balken (E4-1), Laufzeit, Anzahl Subagents

Abnahme:
- Klick führt zu `/issue?id=`.
- Der aktive Avatar pulsiert nur, solange die Session läuft.

**E2-4 Alerts**

Gesammelte Hinweise: bisherige „Needs attention“-Probleme, offene Write-Clashes (E7-4), Limit-Prognose (E4-4),
`needs-human`, Model-Holds. Jede Meldung hat Art, Zeit, Titel, Text und Link.

Abnahme: Zähler im Kopf, leerer Zustand „Alles ruhig“.

**E2-5 Agent-Aktivität**

Strich je Tool-Aufruf der letzten 30 min, farbig nach Rolle, aus den Timelines der Issues.

Abnahme:
- Legende je Rolle.
- Die Grafik hat eine Textalternative (`aria-label`).

**E2-6 Brain-Widgets**

- Brain-Vitals: Notizen, Kandidaten, Links, Waisen, Writes und Reads heute, letzter Commit
- das Zugriffsprotokoll mit Filterchips je Rolle und Suche über Notiz und Zweck
- fehlender Zweck wird als „Zweck fehlt“ angezeigt

Abnahme: Daten aus `GET /api/v1/brain/vitals` und `/api/v1/brain/access`. Blockiert, bis E7-3 und E7-6 da sind.

### E3 Team-Ansicht (Bühne + Partitur)

**E3-1 Subagent-Tracking**

`claude.ts` verfolgt Aufrufe des Agent/Task-Tools:

- Start beim `tool_use` (id, `subagent_type`, Beschreibung)
- Zuordnung der Folge-Nachrichten über `parent_tool_use_id`, Tokens je Subagent
- Ende beim passenden `tool_result`

Im `RunningEntry` stehen die laufenden und die letzten 10 beendeten Subagents.

Abnahme: Unit-Test mit einem aufgezeichneten Nachrichtenstrom (zwei parallele Subagents, einer endet).

**E3-2 Team-API**

`GET /api/v1/<id>/team` liefert:

- Sitze je Rolle des Profils, plus „Du“ für die menschliche Spalte: Status, letztes Verdict, Dauer, Modell
- den aktiven Sitz mit Aktion, den letzten vier Tool-Aufrufen, Context, Turn, Modell, Tokens und Kosten
- die Subagents
- Partitur-Blöcke (Rolle, Start, Ende, Verdict, Runde) und Übergaben (von, nach, Verdict, Zeit)

Abnahme: Werte aus `stages[].sessions` und der Timeline, für laufende und beendete Issues.

**E3-3 Bühne**

- Rollen als Sitze in Pipeline-Reihenfolge auf einer „Bühnenkante“.
- Fertig: Häkchen. Rückgabe: rotes Kreuz. Wartet: gestrichelt.
- Der aktive Sitz ist größer, mit Spotlight, Puls-Ring, Equalizer und Context-Ring mit Prozentzahl.
- Daneben drei Felder: „Jetzt“ (Aktion und Spur der letzten Tool-Aufrufe), Session (Context mit
  Auto-Compact-Marke, Turn, Dauer, Modell, Tokens) und Subagents (pulsierend, solange sie laufen).

Abnahme:
- Ohne laufende Session ist kein Sitz animiert.
- Bei 390 px stehen die Sitze in zwei Reihen.

**E3-4 Partitur**

- eine Swimlane je Rolle auf gemeinsamer Zeitachse
- Blöcke = Sessions; Strichdichte = Tool-Aufrufe
- Pfeile zwischen den Lanes = Übergaben mit Verdict, gestrichelte Linie bei jedem Rundenwechsel
- „Jetzt“-Linie

Abnahme:
- Ein Block hat einen Tooltip mit Rolle, Dauer, Modell und Verdict.
- Die Zeitachse passt sich der Gesamtdauer an.
- Bei schmaler Breite scrollt sie horizontal in ihrem Rahmen.

**E3-5 Seitenleisten und Trace**

- Ergebnisse je Stage
- Context-Verlauf des Developers über alle Runden mit Compact-Markern
- Brain-Zugriffe und Changes dieses Issues
- darunter Tabs mit dem bisherigen Execution-Trace, Sessions und Transkript, übernommen aus `agent-page.ts`

Abnahme: Alle Funktionen der heutigen Agent-Seite (Pause, Force, Filter, Raw-Logs) sind erreichbar.

### E4 Context-Budgets und Limit-Prognose

**E4-1 Context-Füllstand je Session**

Nach jedem Model-Call wird `input + cache_read + cache_creation` gegen die Fenstergröße gerechnet:

- Die Fenstergrößen stehen neu je Modell in `model-costs.yml`.
- `[1m]` wird über `model-name.ts` erkannt.

`compact_boundary` zählt Auto-Compacts und speichert `pre_tokens`. Sichtbar wird das in `running` und in `run_finished`
(höchster Wert, Anzahl Compacts).

Abnahme:
- Test für 200k und 1M.
- Ein unbekanntes Modell zeigt „—“ statt einer falschen Prozentzahl.

**E4-2 Rate-Limit-Events speichern**

Jedes `rate_limit_event` wird als JSONL geschrieben (`<logDir>/budget/rate-limits.jsonl`) mit `at` (ISO), `run_id`, 
`issue`, `role`, `model` und dem rohen `rate_limit_info`-Objekt des SDK. `state.rate_limits` zeigt ein Objekt mit dem 
jeweils letzten Event je `rateLimitType` (`five_hour`, `seven_day` o. ä.), `{}` vor dem ersten Event. Zeilen älter als 
30 Tage werden beim Start und danach einmal täglich entfernt (Konstante, kein Config-Schlüssel). Schreibfehler werden 
nur geloggt.

Abnahme: JSONL mit Quellkontext (Run, Issue, Rolle, Modell), Rotation nach 30 Tagen, `state.rate_limits` je Typ.

**E4-3 Spike: Auslastung aus dem SDK**

Prüfen, ob `rate_limit_info` eine Auslastung oder Schwelle liefert (`utilization`, `surpassedThreshold` o. ä.). Das
Ergebnis kommt als Kommentar in dieses Konzept zurück.

Abnahme: Beispiel-Payloads aus echten Sessions dokumentiert.

Erfüllt: Ergebnis in #332 und im Spike-Kommentar von cooolinho vom 2026-11-01 auf #320; die Payloads und Befunde stehen
in `docs/agent-claude.md` (E4-10, #465).

**E4-4 Prognose und API**

`GET /api/v1/budget` liefert je Fenster: Verbrauch, Burn-Rate (30 min gleitend), geschätzte Grenze (SDK-Auslastung
oder kalibriert aus `session_limit`-Treffern in der History), ETA und Reset. Ein Alert entsteht, wenn die ETA vor dem
Reset liegt.

Abnahme:
- Reine Funktion mit Tests für „kein Treffer bekannt“ (Prognose `null`), „Treffer bekannt“ und „ETA nach Reset“ (kein
  Alert).

**E4-5 Budget-Anzeige**

- Übersicht: Fenster-Balken mit schraffierter Prognose, Tokens je Rolle, Hinweis auf Sessions über 70 % Context
- Kopfzeile: 5-h-Chip

Abnahme: Ohne Prognose zeigen die Balken nur den Verbrauch, ohne Schraffur.

### E5 Tasks

**E5-1 Tasks-Seite**

Spalten Läuft, Als Nächstes, Wartet, Pausiert, Blockiert und Kürzlich erledigt (die letzten 10 aus der History). Jede
Karte zeigt Nummer, Titel, Repo, Priorität bzw. Platz, Grund-Chip aus `PlanReasonCode`, die zuständige Rolle und die
passende Aktion: Pausieren, Jetzt starten, Erneut versuchen, Fortsetzen.

Abnahme:
- Alle Aktionen nutzen die bestehenden Endpunkte und `controlAllowed`.
- Leere Spalten sind sichtbar, mit Leertext.

**E5-2 Steuerung umziehen**

Slot-Regler und Model-Holds ziehen vom Dashboard in den Kopf der Tasks-Seite. Die alten Abschnitte in `dashboard.ts`
entfallen.

Abnahme: `PUT/DELETE /api/v1/settings/agents` und die Hold-Endpunkte funktionieren unverändert.

### E6 Changes

**E6-1 Code-Änderungen erfassen**

`workspace/changes.ts` bekommt `diffStat()` (`git diff --numstat` gegen die Merge-Base). Daraus werden
`ChangeEntry`s je Commit und je Merge mit PR-Nummer und Check-Status vom Tracker. `changed_files` aus den Ergebnissen
wird in `stage-history.ts` weitergegeben.

Abnahme: Test mit einem Fixture-Repository (eine Datei geändert, eine neu, eine gelöscht).

**E6-2 Brain-Änderungen erfassen**

Die Einträge entstehen aus dem Vault-Git (E7-3): erstellt, geändert, befördert, verworfen, abgewiesen (aus dem
Access-Log), jeweils mit Diff-Auszug von höchstens 5 Zeilen.

Abnahme: Ein abgewiesener Write erscheint als Konflikt.

**E6-3 Changes-API und -Seite**

`GET /api/v1/changes?type=&repo=&issue=&before=` liefert die Einträge seitenweise. Die Seite hat:

- Filter Alle/Code/Brain mit Zählern und Repository-Auswahl
- im Feed: Dateien mit +/−-Balken bzw. Diff, Status-Chip, bei Kandidaten Befördern/Verwerfen
- rechts „Heute in Zahlen“ und Hotspots der letzten 7 Tage

Abnahme: Filter stehen in der URL.

### E7 Brain-Kern

**E7-1 Vault und Struktur**

- neues Volume `brain`, im Symphony-Container unter `/home/symphony/brain` (UID 1000)
- Konfiguration `brain.path` und `brain.enabled` in `WORKFLOW.md`
- beim ersten Start legt Symphony an: `README.md` (Regeln), `Inbox/`, `Repos/`, `Decisions/`, `Lessons/`,
  `Issues/`, `Agents/`; `.obsidian/` gehört dem Menschen und wird nie beschrieben

Abnahme: Ohne `brain.enabled` ändert sich nichts.

**E7-2 Brain-Tools**

In-process-MCP-Server im Muster der Tracker-Tools: `brain_search(query, repo?, type?)`, `brain_read(path)`,
`brain_list(folder)`, `brain_write(path, content, purpose, base_hash?)`, `brain_append(path, heading, text, purpose,
base_hash)`.

- Pfade bleiben im Vault (kein `..`, nicht `.obsidian/`).
- Das Frontmatter wird geprüft.
- Neue Notizen bekommen `status: candidate`.
- Die Suche läuft über Dateien (Titel, Frontmatter, Volltext), `approved` zuerst.
- Nach jedem erfolgreichen Write ruft das Brain-Modul den Hook `onWrite(entry)` auf (`BrainWriteEntry`: Tool, Pfad, `purpose`, `hash`, `previousHash`, `created`, Issue, Rolle, Run); E7-3 (Commit) und E7-4 (Access-Log) hängen sich daran.

Abnahme:
- Tests für Pfad-Ausbruch, fehlenden `purpose` (Warnung im Log, kein Abbruch) und Suche mit Statusreihenfolge.

**E7-3 Versionierung**

Der Vault ist ein Git-Repository. Jeder erfolgreiche Write wird ein Commit (Autor `symphony-<rolle>`, Nachricht mit
Issue, Run und Zweck). Änderungen des Menschen in Obsidian committet Symphony zusammengefasst vor dem nächsten
Agent-Write.

Abnahme:
- Ein Revert eines Agent-Commits stellt die vorige Fassung her.
- Test mit einem temporären Repository.

**E7-4 Access-Log und Clash-Erkennung**

Jeder Tool-Aufruf landet als `BrainAccess` im JSONL. Ein Write wird abgewiesen, wenn
- `base_hash` nicht zur aktuellen Datei passt, oder
- ein anderer Run dieselbe Datei innerhalb von `brain.clash_window` (Standard 10 min) geschrieben hat.

Der Agent bekommt dann die aktuelle Fassung zurück, und ein `BrainClash` entsteht.

Abnahme: Tests für beide Gründe; derselbe Run darf seine eigene Notiz sofort erneut schreiben.

**E7-5 Rollen und Prompt**

- Neuer Rollenschalter `brain: off|read|write` in `WORKFLOW.md`. Standard: Analyst, Architect und Reviewer `write`,
  Developer, Tester und Security `read`, Docs `off`.
- Ein Prompt-Abschnitt im `WORKFLOW.md`-Template erklärt Lesen zu Beginn, `purpose`, Kandidaten und wann eine Lesson
  sinnvoll ist.
- Direkter Dateizugriff auf den Vault ist nicht möglich: Der Vault liegt außerhalb der Workspaces und ist nicht in
  `additionalDirectories`.

Abnahme: Test, dass `off` keine Brain-Tools registriert und `read` nur lesende.

**E7-6 Vitals und Brain-API**

Ein Indexer liest beim Start und nach jedem Commit Frontmatter und `[[Links]]`. Daraus entstehen:

- Notizen je Status, Links, Waisen, kaputte Links
- Kandidaten-Liste, Writes/Reads heute, letzter Commit

`GET /api/v1/brain/vitals`, `/access`, `/candidates`, `/clashes`; `POST /api/v1/brain/candidates/<pfad>/approve` und
`/reject` (über `controlAllowed`).

Abnahme: Der Index bleibt bei 2.000 Notizen unter 1 s.

**E7-7 Brain-Seite**

- Vitals mit Statusbalken
- Kandidaten-Review mit Befördern, In Obsidian bearbeiten, Verwerfen und Rückgängig
- Graph-Ausschnitt rund um `Repos/<repo>/index` mit kaputten Links
- Ordnerstruktur mit Zählern
- Write-Clashes mit Fassungsvergleich und „gelöst“
- „In Obsidian öffnen“ führt zur URL aus `brain.obsidian_url`

Abnahme: Befördern verschiebt die Notiz an den Zielpfad aus ihrem Frontmatter und setzt `status: approved`.

### E8 Brain-Betrieb und Pflege

**E8-1 Obsidian-Container**

Dienst `obsidian` (`lscr.io/linuxserver/obsidian`) in `docker-compose.yml`:

- dasselbe Volume `brain`, `PUID`/`PGID` 1000
- Traefik-Route `${BRAIN_DOMAIN}` über reines HTTP (wie das Dashboard mit `TRAEFIK_TLS=false`), mit derselben
  Basic-Auth-Middleware wie das Dashboard, nur über den LAN-Entrypoint
- `.env.example` und `docker-compose.local.yml` werden ergänzt

Abnahme:
- `docker compose up obsidian` öffnet den Vault im Browser.
- Dateirechte bleiben bei UID 1000.

**E8-2 Doku**

`docs/brain.md` (Englisch, wie die übrige Doku) beschreibt Zweck, Ordner und Frontmatter, Rollenschalter, Clash-Regeln,
den Obsidian-Container, Backup (Volume + Git) und Rücksetzen. Dazu kommt ein Verweis in `docs/configuration.md` und in
der README.

Abnahme: Alle neuen `WORKFLOW.md`-Schlüssel sind in `docs/configuration.md` beschrieben.

**E8-3 Issue-Zusammenfassungen**

Nach dem Merge schreibt Symphony `Issues/<repo>/<nr>.md`:

- Ziel, Ergebnis je Stage, Runden, Kosten, geänderte Dateien
- Links auf die PR und auf `Repos/<repo>/index`
- `status: approved`, Autor `symphony`

Abnahme: idempotent; ein zweiter Merge-Lauf überschreibt nicht doppelt.

**E8-4 Obsidian-Ansichten**

Symphony legt Bases-Dateien an, die nur Obsidian rendert: „Kandidaten-Review.base“ (Inbox nach Alter) und
„Neueste Lessons.base“.

Abnahme: Die Dateien sind gültiges YAML nach der Bases-Syntax.

**E8-5 Gärtner-Rolle (letzte Ausbaustufe)**

Rolle `brain-gardener`, gestartet per Issue-Befehl `/brain-garden`. Sie findet Dubletten, Waisen und kaputte Links und
schlägt Zusammenführungen als Kandidaten vor. Sie befördert nie selbst.

Abnahme: Der Lauf ändert keine `approved`-Notiz direkt.

### E9 Statistik in neuer Hülle

**E9-1 Statistik-Seite umziehen**

`logs-page.ts` und `charts.ts` laufen in der neuen Hülle unter `/stats` mit Glas-Komponenten. Alle bisherigen
Auswertungen und Filter bleiben.

Abnahme: Die bisherigen Analytics-Tests laufen unverändert.

**E9-2 Budget-Historie**

- Spitze je Tag im 5-h-Fenster, Limit-Treffer markiert
- Auto-Compacts je Rolle
- Ø Context je Rolle in der Rollentabelle

Abnahme: Daten aus E4-2 und `run_finished` (E4-1).

## Nicht-funktionale Anforderungen

- **Leistung:**
  - höchstens 4 überlagerte Blur-Ebenen pro Seite
  - Animationen nur mit `transform`/`opacity`
  - die Übersicht rendert eine `/api/v1/state`-Antwort mit 20 Issues in unter 50 ms
- **Barrierefreiheit:**
  - Kontrast 4.5:1, Fokus sichtbar
  - echte `<button>`/`<a>`, Grafiken mit Textalternative
  - Bewegung und Transparenz abschaltbar über Systemeinstellungen
- **Sicherheit:**
  - neue Schreib-Endpunkte nur über `controlAllowed`
  - Brain-Pfade geprüft, `.obsidian/` tabu
  - Obsidian-Container nur im LAN und hinter Basic-Auth
- **Robustheit:** Fehlen Brain, `/proc` oder GPU, blendet die Oberfläche den Bereich aus statt Fehler zu zeigen.

## Reihenfolge (Abhängigkeiten)

- E1-1 → E1-2 → E1-3 → E1-4 sind das Fundament aller Seiten.
- E1-5 läuft parallel zu den ersten Seiten.
- Diese Daten-Anforderungen brauchen keine Oberfläche und können sofort starten: E2-1, E3-1, E4-1, E4-2, E4-3,
  E6-1, E7-1 bis E7-4.
- Brain-Oberfläche (E2-6, E6-2, E7-7) erst nach E7-3, E7-4 und E7-6.
- E8-1 nach E7-1; E8-5 zuletzt.

## Roast: offene Fragen

Jede offene Frage hat eine Standardannahme, mit der gebaut wird, solange keine Antwort kommt.

**Entschieden am 2026-10-27**

1. **UI-Sprache:** Deutsch. Fachbegriffe wie Changes und Tasks bleiben Englisch, die Doku auch.
2. **GPU:** Der Server hat keine GPU. Die Karte ist vorbereitet, aber abgeschaltet (`system.gpu: false`, E2-1).
3. **Ein Vault für alles:** ja, mit einem Ordner je Repo.
6. **Obsidian über reines HTTP:** reicht, kein eigenes Zertifikat.

**Entschieden am 2026-11-01**

5. **Liefert das SDK eine Auslastung?** Ja. `rate_limit_event` trägt `utilization` und `surpassedThreshold`, und
   `unifiedWindows` nennt in jedem Event die Auslastung aller Fenster (Spike E4-3, #332; Kommentar von cooolinho vom
   2026-11-01 auf #320). Die Kalibrierung aus `session_limit`-Treffern ist nur noch Fallback ohne SDK-Wert.

**Noch offen**

4. **Was schreibt Symphony automatisch?**
   - **Annahme:** nur Issue-Zusammenfassungen nach dem Merge (E8-3).
   - Auch Check-Fehlschläge automatisch als Lesson? Das wäre schnell Lärm.
7. **Retention.**
   - Transkripte und History rotieren heute nie; Budget- und Access-Logs kommen dazu.
   - **Annahme:** neue JSONL-Dateien 30 Tage, Rest unverändert. Für die alten Logs ein eigenes Issue.
8. **Mobile.**
   - **Annahme:** Desktop zuerst, responsiv bis 390 px, keine eigene Handy-Ansicht.
   - Obsidian im Browser ist auf dem Handy ohnehin zäh.
9. **Bremsen statt warnen?**
   - Soll Symphony bei ETA < 30 min keine großen Sessions (fable, L/XL) mehr starten?
   - **Annahme:** nur warnen. Bremsen wäre ein Eingriff in den Dispatcher und gehört in ein eigenes Konzept.
10. **Wer befördert wirklich?**
    - 17 Kandidaten nach einem Tag im Mockup sind realistisch. Wenn du nicht regelmäßig reviewst, liest kein Agent
      jemals neues Wissen (approved first).
    - **Annahme:** Kandidaten werden beim Lesen mitgeliefert, nur nachrangig. Das Dashboard zeigt den Rückstau als Alert
      ab 25.
