# Konzept: Übersicht in voller Breite mit Masonry-Raster

Status: Mockup A abgenommen am 2026-11-24 · Version des Konzepts: 2 (Alerts-Glocke, Limit-Prognose im Context-Budget)

Mockup (verbindliche Vorlage): [mockup.html](mockup.html) mit drei Zuständen (`?state=live|idle|calm`) und offenem
Alerts-Modal (`?alerts=1`)

| Vorschau | Datei |
|---|---|
| 2560 px, 6 Spalten | [preview-2560.png](preview-2560.png) |
| 1920 px, 4 Spalten | [preview-1920.png](preview-1920.png) |
| 1920 px, Alerts-Modal offen | [preview-1920-alerts.png](preview-1920-alerts.png) |
| 1920 px, kein Team läuft | [preview-1920-idle.png](preview-1920-idle.png) |
| 1440 px, 3 Spalten | [preview-1440.png](preview-1440.png) |
| 390 px, 1 Spalte | [preview-390.png](preview-390.png) |
| 390 px, Alerts-Modal offen | [preview-390-alerts.png](preview-390-alerts.png) |
| Ist-Zustand v1.8.0 (Demo-Daten, 1920 px) | [ist-1920.png](ist-1920.png) |

## Ziel

Die Übersicht (`/`) nutzt die ganze Bildschirmbreite und wird deutlich kürzer:

1. **Volle Breite:**
   - Alle Seiten verlieren die feste Maximalbreite.
   - Es bleibt ein schmaler Rand von 16 px (12 px auf dem Handy).
2. **Masonry-Raster:**
   - Die Karten der Übersicht liegen in gleich breiten Spalten.
   - Jede Karte rückt in die Lücke, die am weitesten oben frei ist. Es bleiben keine Löcher wie heute unter den Alerts.
3. **Kompakte Karten:**
   - Keine Karte ist höher als nötig.
   - Lange Listen (Brain-Zugriffe, Agent activity) zeigen auf der Übersicht nur die jüngsten Einträge und verlinken
     auf die ganze Liste.
4. **Keine Doppelung:**
   - Ein laufendes Issue erscheint nur noch einmal, als Zeile in „Teams live“.
   - Der Abschnitt „Running“ mit den großen Agent-Karten entfällt.
5. **Alerts hinter einer Glocke:**
   - Die Alerts-Karte der Übersicht entfällt.
   - Die Limit-Prognosen („5-h-Limit in Sicht“, „7-Tage-Limit in Sicht“) stehen direkt im Context-Budget beim
     jeweiligen Fenster.
   - Alle anderen Alerts zeigt eine Glocke in der Kopfleiste an, auf jeder Seite. Ein Klick öffnet ein Modal mit den
     aktiven und den zuletzt erledigten Alerts.

Messbar: Bei 1920×1080 und den Demo-Daten (`node scripts/demo.ts`) ist die Übersicht höchstens zwei Bildschirmhöhen
hoch. Heute sind es 4465 px, das Mockup braucht unter 1000 px.

Zielgruppe ist der Betreiber der Instanz (eine Person, Desktop zuerst, Handy muss funktionieren).

## Ausgangslage (Stand v1.8.0)

Gemessen auf der Live-Instanz bei 2560×1215 px:

| Befund | Wert | Ursache |
|---|---|---|
| genutzte Breite | 1400 von 2560 px | `.shell-wrap { max-width: 1440px }` in `src/http/ui/layout.ts:129`, zusätzlich `main { max-width: 1480px }` in `src/http/ui/tokens.ts:158` |
| Seitenhöhe Übersicht | 6824 px (≈ 5,6 Bildschirme) | alle Abschnitte untereinander, jeder in voller Breite |
| Brain-Zugriffe | 4466 px hoch (65 % der Seite) | 50 Einträge (`BRAIN_LIMIT = 50`, `src/http/overview-brain.ts:65`), je 3–4 Zeilen, keine Höhenbegrenzung |
| Lücke unter Alerts | ≈ 340 px leer | `.ov-row` ist ein Flex-Wrap (`src/http/dashboard.ts:177`): Alerts 258 px neben Budget 598 px |
| Teams live und Running | dasselbe Issue zweimal | `#teams-section` und `#running-section` (`src/http/dashboard.ts:241-257`), siehe `ist-1920.png` |
| leere Abschnitte | volle Breite, je ≈ 90–200 px | „Kein Team spielt gerade“, „No agents running“, leerer Aktivitäts-Strip |
| Limit-Prognose doppelt | Alert-Karte „5-h-Limit in Sicht“ neben dem Context-Budget, das dieselbe Prognose zeigt | `alerts()` in `src/http/alerts.ts:119-132` erzeugt die Art `budget` aus demselben `/api/v1/budget`-Bericht |
| Alerts nur auf der Übersicht | Auf Changes, Tasks, Brain und Statistik ist kein Alert zu sehen | `#alerts` steht nur in `DASHBOARD_HTML` (`src/http/dashboard.ts:231`). Die Shell holt `/api/v1/budget` dagegen schon auf jeder Seite (`src/http/ui/layout.ts:356`). |

Der Aufbau der Übersicht steht in `DASHBOARD_HTML` (`src/http/dashboard.ts:207-283`). Die Abschnitte kommen aus:

- `overview-head.ts` (Seitenkopf, Status-Chips)
- `overview-teams.ts` (Teams live)
- `alerts.ts`
- `budget-chart.ts` (Context-Budget mit Verlaufsgraph)
- `overview-activity.ts` (Agent-Aktivität, 30 min)
- `overview-brain.ts` (Brain-Vitals, Brain-Zugriffe)
- `dashboard.ts` selbst (System, Kennzahlen, Running, Feed „Agent activity“)

Die Seite pollt `/api/v1/state` alle 2 s. Die HTTP-Tests prüfen Quelltext-Strings und den DOM im Fake-DOM:

- `test/http.test.ts`
- `test/repositories-dashboard.test.ts`
- `test/overview-teams-merge.test.ts`
- `test/tasks-page-steering-independent.test.ts`

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Breite | Keine `max-width` mehr in `.shell-wrap` und `main`, auf allen Seiten. Rand `--edge: 16px`, ab ≤ 640 px `12px`. Kopfleiste und Seitenkopf laufen mit. |
| Lesebreite | Text-lastige Seiten (Changes, Logs, Issue/Team, Brain) dürfen **innerhalb** ihrer Karten eine Lesebreite begrenzen (z. B. `max-width: 120ch` für Fließtext). Die Seite selbst bleibt voll breit. |
| Raster | CSS-Grid `repeat(auto-fill, minmax(min(380px, 100%), 1fr))`, `grid-auto-rows: 4px`, `row-gap: 0`, Kartenabstand als `margin-bottom` = `column-gap` = 16 px. |
| Masonry-Technik | Jede Karte belegt `grid-row-end: span ceil((Höhe + Abstand) / 4px)`. Ein `ResizeObserver` je Karte rechnet nur neu, wenn sich die Höhe ändert. `grid-auto-flow: row dense` füllt Löcher neben breiten Karten. **Nicht** CSS-`columns`: Dort springen Karten beim 2-s-Poll zwischen Spalten. **Nicht** `grid-template-rows: masonry`: In Chrome gibt es das nicht. |
| Spalten | ergeben sich aus der Breite: 1 Spalte bei 390 px, 3 bei 1440 px, 4 bei 1920 px, 6 bei 2560 px |
| Breite Karten | „Teams live“ und „Agent-Aktivität“ belegen ab 1220 px Viewport zwei Spalten (`.wide`). Alle anderen Karten sind eine Spalte breit. |
| Reihenfolge | DOM-Reihenfolge = Lesereihenfolge wie im Mockup: Teams live, Context-Budget, System, Kennzahlen, Agent-Aktivität, Brain-Vitals, Brain-Zugriffe, Agent activity. `dense` darf spätere kleine Karten in frühere Lücken ziehen. Fokus- und Screenreader-Reihenfolge folgen dem DOM. |
| Alerts-Karte | Die Karte `#alerts` entfällt auf der Übersicht. Die Ableitung `alerts(state, budget, brain)` in `alerts.ts` bleibt die eine Quelle für alle Alerts. |
| Limit-Prognose | Alerts der Art `budget` erscheinen nicht mehr in der Alert-Liste. Ein Prognose-Hinweis steht im Context-Budget direkt unter dem Balken des jeweiligen Fensters: amber „Prognose · 5-h-Limit in Sicht · Limit ca. 19:40, 3 h 30 min vor dem Reset“, rot „Limit · 7-Tage-Limit erreicht · Dispatch pausiert bis 10:01“. Er erscheint unter derselben Bedingung wie heute der Alert (`w.alert === true` mit `forecast.eta`) bzw. wenn das Fenster 100 % erreicht hat. Mit `role="status"` liest ein Screenreader ihn vor. |
| Glocke | Ein Glocken-Knopf in der Kopfleiste zwischen „Board“ und Version, auf **allen** Seiten der Shell. Die Zahl im Badge ist die Zahl der aktiven Alerts (ohne `budget`). Das Badge ist rot, sobald ein roter Alert (Fehler, Write-Clash) dabei ist, sonst amber. Ohne aktive Alerts gibt es kein Badge. Neue, noch ungesehene Alerts lassen die Glocke kurz wackeln. Nach dem Öffnen des Modals gelten sie als gesehen, gemerkt per `localStorage` über Art + Titel. `prefers-reduced-motion` schaltet das Wackeln ab. `aria-label` nennt Zahl und Art („Alerts: 3 aktiv, davon 1 Fehler“). |
| Alerts-Modal | natives `<dialog>` mit `showModal()`: Esc und Klick auf den Hintergrund schließen es, der Fokus geht zurück auf die Glocke. Inhalt: „Aktiv · N“ (die Karten wie heute aus `renderAlerts`, neueste zuerst, jede ein Link) und „Zuletzt erledigt“ (bis zu 10 Alerts, die aus der Liste verschwunden sind, mit Zeitraum „von–bis“). Ohne aktive Alerts steht dort „Alles ruhig. Kein aktiver Alert.“ Fußzeile: „Limit-Prognosen stehen im Context-Budget, nicht hier.“ |
| Alerts-Verlauf | „Zuletzt erledigt“ entsteht im Browser: Der Client vergleicht die Alert-Liste zwischen zwei Polls und merkt sich verschwundene Einträge in `localStorage` (max. 10, älter als 24 h fällt heraus). Es gibt keine neue API und keine Ablage auf dem Server. |
| Alerts auf Unterseiten | Die Übersicht speist die Glocke aus ihrem Poll. Die anderen Seiten holen in der Shell alle 30 s `/api/v1/state` (gibt es schon), `/api/v1/budget` (holt die Shell schon) und, wenn das Brain aktiv ist, die Brain-Daten wie `loadBrainAlerts` und rechnen mit demselben `alerts()`. |
| Running | Der Abschnitt `#running-section` entfällt ersatzlos, mitsamt den großen Agent-Karten. |
| Teams live | Die Zeile je Issue bleibt wie heute (Avatare, aktive Rolle, Aktion, Context-Balken, Laufzeit, Subagents). Neu ist eine dritte Kopfzeile **Modell · Phase** aus der früheren Running-Karte (z. B. `opus · StreamingTurn`). Die ganze Zeile verlinkt auf die Team-Ansicht, dort liegt der Trace. Die Zeile „x Slots belegt · y in der Queue“ zieht in den leeren Zustand von Teams live bzw. in die System-Kachel „Slots“. |
| Kopf | Repositories-Leiste (`#repositories`) und Dispatch-Gate (`#dispatch-gate`) sind keine eigenen Balken mehr. Sie werden Chips in der Statuszeile neben Tracker, Workflow und Watchdog. Die Dispatch-Pause ist ein amber Chip mit dem Grund im `title`. |
| System | sechs kompakte Kacheln (3 × 2, auf dem Handy 2 × 3) mit Wert und Balken. Die Sparklines entfallen auf der Übersicht, der Verlauf bleibt auf der Statistik-Seite. |
| Kennzahlen | ein Raster aus 8 Kacheln (4 × 2, auf dem Handy 2 × 4) statt sieben breiter Kacheln über die ganze Seite. Neu ist „Runden“. |
| Context-Budget | 5-h- und Wochenbalken bleiben. Der Verlaufsgraph steckt in einem `<details>`, Standard offen. Der Zustand wird pro Browser in `localStorage` gemerkt. Die Liste „Tokens je Rolle“ wandert auf die Statistik-Seite. |
| Brain-Zugriffe | auf der Übersicht die **8** jüngsten Einträge, je **eine Zeile** (Zeit · Rolle #Issue · Operation · Notiz), Titel „Brain-Zugriffe 8 von 50“, Link „Alle auf der Brain-Seite →“. Rollen-Filter und Suche ziehen mit der vollständigen Liste auf die Brain-Seite. |
| Agent activity | feste Höhe (ca. 8 Zeilen) mit innerem Scrollen, eine Zeile je Ereignis (Zeit · Issue+Rolle · Ereignis) |
| Leere Zustände | eine Zeile in der Karte statt eines eigenen Blocks: „Kein Team spielt gerade · 0 Slots belegt · 0 in der Queue“, „Alles ruhig“ |
| Technik | wie bisher framework-frei und ohne Build. DOM über `el()`, kein `innerHTML` für Daten. Polling bleibt. |

## Nicht-Ziele

- Karten per Drag-and-drop verschieben, ein- und ausblenden oder in der Größe ändern
- neue Datenquellen oder API-Felder. Modell und Phase gibt `/api/v1/state` schon heute je laufendem Issue aus.
- ein neues Layout der Unterseiten (Changes, Tasks, Brain, Statistik, Team-Ansicht) über die volle Breite hinaus
- helles Theme
- die Behebung des 6-Verbindungen-Staus beim Verlassen der Übersicht (eigenes Thema)
- ein Alert-Verlauf auf dem Server, Browser-Benachrichtigungen (Notification API), Töne oder neue Alert-Arten

## Funktionsbereiche

### B1 Shell in voller Breite (Fundament)

`src/http/ui/layout.ts` und `src/http/ui/tokens.ts`:

- `max-width` von `.shell-wrap` (1440 px) und `main` (1480 px) entfernen
- Rand als Token `--edge` (16 px, ≤ 640 px 12 px)
- Alle Seiten prüfen: Übersicht, Changes, Tasks, Brain, Statistik, Logs, Issue/Team-Ansicht.
- Wo Fließtext oder Tabellen bei 2560 px unlesbar breit werden, bekommt die Karte eine innere Lesebreite.

Abnahme:
- Bei 2560 px nutzt jede Seite die Breite bis auf 2 × 16 px.
- Bei 390 px hat keine Seite eine horizontale Scrollleiste.
- Kopfleiste, Brotkrumen und Seitenkopf laufen über die volle Breite.

### B2 Masonry-Raster als Baustein

Ein wiederverwendbarer Baustein in `src/http/ui/`, z. B. `masonry.ts` mit `MASONRY_CSS` und `MASONRY_JS`. Aufbau wie
`overview-teams.ts`, im vm mit Fake-DOM testbar:

- CSS: Grid wie unter „Entscheidungen“, Klasse `.wide` für zwei Spalten ab 1220 px
- JS: `ResizeObserver` je Karte setzt `grid-row-end: span n`. Es wird nur geschrieben, wenn sich `n` ändert. Karten,
  die später dazukommen oder verschwinden (`hidden`), werden beobachtet bzw. freigegeben.
- `hidden`-Karten belegen keinen Platz.
- Ohne `ResizeObserver` (alter Browser) fällt die Seite auf ein normales Grid ohne Span zurück und bleibt bedienbar.

Abnahme:
- Unit-Test: Spanberechnung (Höhe, Abstand, Einheit), kein Schreiben ohne Höhenänderung, `hidden` freigegeben
- Im Browser: Zwischen zwei Karten einer Spalte liegt nie mehr als der Kartenabstand plus eine Einheit (≤ 20 px).
- Ein Poll ohne Höhenänderung verschiebt keine Karte. Geprüft wird das mit einem Poll-Zyklus in der Demo:
  `getBoundingClientRect` aller Karten vorher und nachher gleich.

### B3 Übersicht im Raster

`src/http/dashboard.ts` und die Abschnitts-Module:

- `.ov-row`, `.brain-row` und `.lower` auflösen. Alle Karten werden direkte Kinder eines Masonry-Containers, in der
  Reihenfolge aus „Entscheidungen“.
- Seitenkopf mit Statuszeile:
  - Repositories und Dispatch-Gate als Chips (`overview-head.ts`)
  - `#repositories` und `#dispatch-gate` entfallen als eigene Abschnitte
- System-Karte kompakt (3 × 2), Kennzahlen-Karte kompakt (4 × 2, mit „Runden“)
- Context-Budget:
  - Verlaufsgraph in `<details>` mit gemerktem Zustand, „Tokens je Rolle“ auf die Statistik-Seite
  - Prognose-Hinweis je Fenster unter dem Balken (siehe „Limit-Prognose“). Die Texte kommen aus derselben
    Berechnung wie bisher in `alerts.ts` (`BUDGET_TITLE`, `BUDGET_WINDOW_NAME`, `forecast.eta`, `resets_at`), damit
    Budget-Karte und frühere Alerts nicht auseinanderlaufen. In der Zeile darüber steht dann nur noch Burn und Reset.
- Agent activity: feste Höhe, einzeilige Einträge

Abnahme:
- Die Übersicht entspricht `mockup.html` in Reihenfolge, Kartenbestand und Inhalt je Karte bei 390, 1440, 1920 und
  2560 px.
- Demo-Daten, 1920×1080: Seitenhöhe ≤ 2160 px
- Kein Inhalt geht verloren, außer dem, was diese Entscheidungen ausdrücklich verschieben: Sparklines und „Tokens je
  Rolle“ auf die Statistik-Seite, Brain-Filter auf die Brain-Seite, Alerts hinter die Glocke (B7).
- Bei einem 5-h-Fenster mit `alert: true` zeigt die Budget-Karte den amber Prognose-Hinweis. Bei 100 % im
  Wochenfenster zeigt sie den roten Hinweis. Ohne Prognose gibt es keinen Hinweis.

### B4 Running entfernen, Teams live erweitern

- `#running-section` samt Rendering (`dashboard.ts`, Funktion um `$('running')`), CSS und Leerzustand
  `#issues-empty` entfernen
- Teams-live-Zeile (`overview-teams.ts`): dritte Kopfzeile „Modell · Phase“ in Monospace, abgeschnitten mit
  Ellipse. Die Werte kommen aus dem laufenden Issue im State.
- Leerzustand von Teams live: eine Zeile mit „0 Slots belegt · 0 in der Queue“ (bisher `#tasks-line`)
- Tests anpassen: `test/http.test.ts` (`id="running"`, `tasks-line`), `test/repositories-dashboard.test.ts`
  (`running-section`), `test/overview-teams-merge.test.ts`, `test/tasks-page-steering-independent.test.ts`
  (`tasks-line-text`). Der Tasks-Seiten-Test bleibt unberührt, wenn die Tasks-Seite die Zeile weiter zeigt.

Abnahme:
- Auf der Übersicht erscheint jedes laufende Issue genau einmal.
- Die Teams-live-Zeile zeigt Modell und Phase.
- `npm run check` ist grün.

### B5 Brain-Zugriffe kompakt, vollständige Liste auf der Brain-Seite

- Übersicht (`overview-brain.ts`): 8 Einträge, einzeilig, Titel „8 von N“, Link auf die Brain-Seite. Ob der Client
  mit `limit=8` lädt oder die 50 behält und nur 8 zeigt, entscheidet der Entwurf. Die API bleibt unverändert.
- Brain-Seite (`brain-page.ts`): neuer Abschnitt „Zugriffe“ mit der vollständigen Liste, den Rollen-Filter-Chips und
  der Suche, die bisher auf der Übersicht stehen. Das Verhalten wie heute bleibt erhalten, also Gruppierung nach Tag
  und Zweck je Zugriff.

Abnahme:
- Die Karte Brain-Zugriffe ist bei 1920 px höchstens ≈ 320 px hoch.
- Die Brain-Seite zeigt alle Zugriffe mit Filter und Suche.
- Der Link der Übersicht springt dorthin (Anker).

### B6 Doku und Screenshots

- `docs/screenshots/`: neue Aufnahmen der Übersicht mit Demo-Daten bei 2560, 1440 und 390 px. Überholte Bilder, die
  den Running-Abschnitt, die Alerts-Karte oder die alte Breite zeigen, ersetzen oder entfernen (`e1-3-*`, `e1-8-*`,
  `e2-7-*`, `e2-8-*`, `overview-brain-*`, `e4-5-budget-treffer-alert.png`, `e4-6-budget-panel*`), sofern sie noch
  verlinkt sind. Neu kommen Glocke und Alerts-Modal dazu (Desktop und 390 px).
- `docs/preview.gif` neu aufnehmen. Nur Demo-Daten (`node scripts/demo.ts`), nie die Live-Instanz.
- `docs/usage.md`, `docs/overview.md` und `README.md`/`README.de.md` auf Aussagen zu „Running“ und zum Aufbau der
  Übersicht prüfen
- Dieses Konzept bekommt am Ende den Status „umgesetzt in vX.Y.Z“.

Abnahme:
- In der Doku verweist kein Bild und kein Text mehr auf den Running-Abschnitt.
- Alle neuen Bilder zeigen Demo-Daten (`acme/*`).

### B7 Alerts-Glocke und Modal

`src/http/ui/layout.ts` (Kopfleiste, auf allen Seiten) und `src/http/alerts.ts`:

- Glocken-Knopf in der Kopfleiste mit Badge, Farbe nach dem schwersten Alert, Wackeln bei ungesehenen Alerts
  (siehe „Entscheidungen“)
- Alerts-Modal als `<dialog>` mit den Abschnitten „Aktiv“ und „Zuletzt erledigt“. Die Karten baut weiter
  `renderAlerts`.
- `alerts()` liefert die Art `budget` nicht mehr in die Glocke. Die Budget-Karte bekommt die Prognose aus derselben
  Berechnung (B3).
- Datenquelle: auf der Übersicht ihr Poll, auf den anderen Seiten ein Shell-Poll alle 30 s (State, Budget,
  Brain-Alerts)
- Client-Verlauf „Zuletzt erledigt“ in `localStorage` (max. 10, 24 h)
- Tests anpassen, die die Alerts-Karte der Übersicht prüfen:
  - `test/alerts-panel.test.ts`, `test/alerts-panel-page.test.ts`, `test/alerts-cards.test.ts`,
    `test/alerts-card-source.test.ts`, `test/alerts-brain.test.ts`
  - `test/overview-head.test.ts`, `test/overview-brain*.test.ts`, `test/http.test.ts`,
    `test/watchdog-heartbeat.test.ts`
  - Die Logik-Tests von `alerts()` bleiben. Neu sind Tests für Badge-Zahl und -Farbe, gesehen/ungesehen und den
    Verlauf im Fake-DOM.

Abnahme:
- Auf jeder Seite der Shell zeigt die Glocke dieselbe Zahl.
- Klick, Enter oder Leertaste auf die Glocke öffnen das Modal. Esc oder ein Klick auf den Hintergrund schließen es,
  der Fokus steht danach wieder auf der Glocke.
- Ein Alert, der zwischen zwei Polls verschwindet, steht danach unter „Zuletzt erledigt“ mit Zeitraum.
- Eine Limit-Prognose erscheint nie in der Glocke, nur im Context-Budget.
- Bei 390 px passt das Modal in die Breite (Rand 12 px) und scrollt innen.

## Nicht-funktionale Anforderungen

- **Barrierefreiheit:**
  - Jede Karte ist eine `section` mit `aria-labelledby`.
  - Fokus- und Lesereihenfolge folgen dem DOM, auch mit `dense`.
  - Touch-Ziele mindestens 44 px. Kontrast wie im Glas-Konzept (≥ 4.5:1 für Fließtext).
- **Bewegung:** `prefers-reduced-motion` stoppt Equalizer und Übergänge. Karten wechseln die Position ohne Animation.
- **Leistung:**
  - Ein Poll löst kein Layout-Neuberechnen aller Karten aus, nur Karten mit geänderter Höhe schreiben einen Span.
  - Höchstens ein `ResizeObserver` für alle Karten.
- **Transparenz:** `prefers-reduced-transparency` wie bisher: Panels deckend, ohne Blur.

## Reihenfolge (Abhängigkeiten)

1. B1 Shell in voller Breite und B2 Masonry-Baustein (unabhängig voneinander)
2. B3 Übersicht im Raster (braucht B1 und B2)
3. B4 Running entfernen, B5 Brain-Zugriffe und B7 Alerts-Glocke (brauchen B3, untereinander unabhängig; B7 braucht
   aus B3 die Prognose im Context-Budget, bevor `budget` aus der Alert-Liste fällt)
4. B6 Doku und Screenshots (zuletzt)

## Offene Fragen

1. **Kartenreihenfolge:** Das Mockup stellt Teams live und Context-Budget nach vorn. Vorschlag: Die Reihenfolge
   bleibt fest, damit nichts springt.
2. **Roter Alert:** Soll ein neuer roter Alert (Fehler, Write-Clash) das Modal von selbst öffnen? Vorschlag: nein,
   nur Badge rot und Glocke wackelt.
3. **Verlaufsgraph:** Standard offen. Soll er auf dem Handy (≤ 640 px) standardmäßig zu sein? Vorschlag: ja.
4. **Breite Karten:** Ab 2560 px könnte Teams live drei Spalten belegen, wenn mehr als drei Teams laufen. Vorschlag:
   erst einmal fest zwei Spalten.
