---
name: auto-code
description: Autopilot für ein Repository. Plant aus der Projektbeschreibung die nächste Welle neuer Features, Design-, Qualitäts- und Wartungsaufgaben und legt sie als Sub-Issues an, die Symphony sofort umsetzt; Checkpoints alle paar Wellen. Nur laden, wenn der Prompt es verlangt (Issue-Befehl /auto-code), nie von selbst.
argument-hint: "[Pfad zur Projektbeschreibung] [wave=3] [checkpoint=5]"
---

# Autopilot: die nächste Welle planen

Du entwickelst das Repository selbstständig weiter. Dein einziger Auftrag ist die **Projektbeschreibung**. Daraus planst du
die nächste **Welle**: wenige, kleine Aufgaben, die als Sub-Issues des aktuellen Issues (das Epic) angelegt werden. Sie
starten sofort; Developer und Reviewer setzen sie um, Symphony merged sie in den Basis-Branch. Sind alle Sub-Issues der
Welle geschlossen, startet Symphony dich erneut für die nächste Welle.

Du **änderst nichts**: kein Edit, kein Write, kein Commit, kein Push, keine Änderung an Branches auf dem Remote. Erlaubt
sind lesende Befehle, Messungen, `git fetch` und lokales `git switch --detach`. **Verboten**: `pint` ohne `--test`,
`composer update|require|remove`, `npm install`, `npm audit fix`, `php artisan migrate|db:seed|tinker`,
`git commit|push|reset|rebase` und alles, was Dateien im Repository verändert. Schreibt ein Testlauf Dateien (Cache,
SQLite), ist das in Ordnung, solange sie nicht ins Repository gehören.

**Argumente** (`$ARGUMENTS`, alle optional, Reihenfolge egal):

- ein Pfad: die Projektbeschreibung. Ohne Pfad suchst du `docs/vision.md`, dann `docs/index.md`, dann `README.md`.
- `wave=<n>`: Issues pro Welle, Standard 3. Mehr, als `create_sub_issue` als `remaining` meldet, geht nicht.
- `checkpoint=<n>`: nach jeder n-ten Welle anhalten, Standard 5. `checkpoint=0` hält nie von selbst an.

Text in der Beschreibung des Epics unter der Befehlszeile gilt als Teil des Auftrags (z. B. Schwerpunkte oder eine
Übergabe aus einem früheren Epic).

## Phase 0: Lage bestimmen

Rufe `get_issue` auf. Wichtig sind die Kommentare (Berichte und Wünsche) und die Sub-Issues mit `state` und
`state_reason`.

- **Letzte Welle N** = die höchste Nummer aus Kommentaren, die mit `## Auto-Code Welle <N>` beginnen; ohne solche
  Kommentare ist N = 0.
- **Offene Sub-Issues vorhanden**: Normalerweise startet Symphony dich dann nicht. Fehlt zu ihnen der Bericht (ein
  früherer Lauf brach ab), schreibe den Bericht für die vorhandenen Issues als Welle N + 1 nach und beende den Turn. Gibt
  es den Bericht schon, beende den Turn sofort, ohne etwas zu tun.
- **Checkpoint fällig**: Ist N > 0, `checkpoint` > 0, N durch `checkpoint` teilbar und gibt es noch keinen Kommentar
  `## Auto-Code Checkpoint nach Welle <N>`, gehst du zu [Phase 6](#phase-6-checkpoint). Gibt es diesen Kommentar schon,
  hat ein Mensch das Epic nach dem Checkpoint zurück nach „Ready“ geschoben: Plane weiter.
- **Früher Checkpoint**: Wurden in der letzten Welle zwei oder mehr Sub-Issues als `NOT_PLANNED` geschlossen, passt die
  Richtung nicht. Gehe ebenfalls zu Phase 6, auch wenn noch kein regulärer Checkpoint fällig ist.
- **Epic voll**: Hat das Epic 80 oder mehr Sub-Issues (GitHub erlaubt 100), gehe zu
  [Phase 7](#phase-7-pause-oder-übergabe) (Übergabe).

## Phase 1: Kontext

Ermittle und notiere (Belege aus den Dateien, nicht aus dem Gedächtnis):

- **Projektbeschreibung**: Ziel, Zielgruppen und Rollen, Funktionen, Stack. Besonders den Abschnitt „Leitplanken für den
  Autopiloten“, falls vorhanden (Vorlage: [vision-template.md](vision-template.md)): Nicht-Ziele, Prioritäten,
  Design-Prinzipien, Tabus. Gibt es keine Beschreibung mit erkennbarem Ziel, schreibe, was fehlt (mit Verweis auf die
  Vorlage), und gehe nach „Blocked“.
- **Roadmap**: offene Punkte in `docs/todo.md`, `TODO.md`, `ROADMAP.md` oder Phasen-Dokumenten, in ihrer Reihenfolge.
- **Projektregeln**: `AGENTS.md`, `CLAUDE.md`, `.ai/` (Guidelines, Rules, Skills).
- **Aktueller Stand** auf dem Basis-Branch (der Prompt nennt ihn, sonst der Default-Branch): `git fetch origin`, dann
  `git switch --detach origin/<base>`. `git log --oneline -40` zeigt, was die letzten Wellen gebracht haben. Verschaffe dir
  einen Überblick über Models, Filament-Resources und -Pages, Routen, Livewire-Komponenten und Tests. Nutze
  Laravel-Boost-Tools (`application-info`, `database-schema`, `list-routes`, `search-docs`), wo verfügbar.
- **Historie im Epic**:
  - Frühere Wellen-Berichte mit ihrem Ideen-Backlog.
  - Sub-Issues mit `state_reason: NOT_PLANNED`: Diese Ideen hat ein Mensch **abgelehnt**, sie sind tabu, auch umformuliert.
  - **Kommentare von Menschen seit dem letzten Bericht**: Das sind Wünsche und Kurskorrekturen. Sie haben Vorrang vor
    allem anderen.

## Phase 2: Baseline

Miss nur, repariere nichts. Nutze zuerst die Skripte aus `composer.json` und `package.json` (`test`, `lint`, `analyse` …),
sonst `php artisan test` bzw. `vendor/bin/pest`, `vendor/bin/phpstan analyse`, `vendor/bin/pint --test`. Notiere pro Befehl eine
Zeile (grün, rot mit Anzahl, nicht vorhanden). Halte dich an die Projektregeln, welche Befehle in einer Symphony-Workspace
laufen dürfen. Was nicht lokal läuft, vermerkst du als „nicht ausgeführt“.

**Ist der Basis-Branch rot** (Tests oder Analyse schlagen fehl), wird diese Welle eine **Reparatur-Welle**: nur Issues der
Kategorie `quality`, die ihn wieder grün machen. Neue Features erst danach.

## Phase 3: Ideen sammeln und bewerten

Die Quellen in dieser Reihenfolge, die Kriterien und das Bewertungsraster stehen in [ideation.md](ideation.md):

1. Wünsche aus den Kommentaren von Menschen im Epic.
2. Offene Punkte der Roadmap, in ihrer Reihenfolge.
3. Lücken zwischen Projektbeschreibung und Code: beschriebene Funktionen, die fehlen oder unvollständig sind.
4. Eigene Ideen, die das Ziel der Projektbeschreibung spürbar voranbringen: Features, Design und UX, Qualität, Wartung.

Jede Idee braucht einen **Bezug zur Projektbeschreibung** (Abschnitt oder Zitat) und einen **Beleg im Code** (Datei,
Route oder Resource, an der sie ansetzt). Ideen ohne beides verwirfst du. Nicht-Ziele, Tabus, abgelehnte Ideen und
erledigte Arbeit sind ausgeschlossen.

## Phase 4: Welle zuschneiden

1. Wähle höchstens `wave` Ideen mit dem besten Verhältnis aus Nutzen zu Aufwand und Risiko. Halte die
   [Mischregeln](ideation.md#mischregeln) ein.
2. Jedes Issue ist **einzeln mergebar**, Größe S oder M. Eine Idee der Größe L teilst du in mehrere Issues über mehrere
   Wellen, die erste Scheibe kommt in diese Welle.
3. Berühren zwei Issues derselben Welle dieselben Dateien, verkette sie mit `Blocked by #N` (wörtlich, Englisch), oder
   verschiebe eines in eine spätere Welle.
4. Jedes Issue bekommt prüfbare **Akzeptanzkriterien** und sagt, welche Tests es braucht. Bei Design-Issues sind die
   Kriterien konkret (Komponenten, Layout, Texte, Zustände), nie „schöner machen“.
5. Labels: `auto-code`, die Kategorie (`feature`, `design`, `quality` oder `maintenance`) und `Effort: medium` (S) bzw.
   `Effort: high` (M). Ein Major-Upgrade (Laravel, Filament, PHP) steht allein in seiner Welle und bekommt zusätzlich
   `manual-merge`: Das merged ein Mensch.
6. Ein reines Refactoring ohne Verhaltensänderung beginnt mit `/refactor-safely` in der ersten Zeile. Fehlen in dem
   Bereich Tests, kommt zuerst ein Test-Issue, auf das das Refactoring wartet (`Blocked by #N`).

## Phase 5: Ausgabe

Die Vorlagen stehen in [templates.md](templates.md).

1. Sub-Issues mit `create_sub_issue` anlegen, abhängige zuletzt (sie verweisen auf frühere Nummern). Der Titel ist
   zugleich der Schlüssel gegen Duplikate: Bei einem Retry denselben Titel verwenden.
2. Genau einen Kommentar `## Auto-Code Welle <N+1>` mit `add_comment` posten: Auswahl mit Begründung, Baseline,
   Ideen-Backlog (die besten nicht gewählten Ideen) und Hinweise. Abgelehnte (`limit_reached`) und unbekannte Labels
   (`unknown_labels`) gehören dazu.
3. **Den Turn beenden, ohne den Status zu ändern.** Das Epic bleibt in „In progress“; Symphony startet dich wieder, wenn
   alle Sub-Issues der Welle geschlossen sind.

Findest du keine Idee, die die Kriterien erfüllt, legst du **nichts** an: [Phase 7](#phase-7-pause-oder-übergabe).
Beschäftigungstherapie schadet dem Projekt mehr als eine Pause.

## Phase 6: Checkpoint

1. Fasse die Wellen seit dem letzten Checkpoint zusammen (Vorlage „Checkpoint“): erledigt, abgelehnt, offenes
   Ideen-Backlog, Zustand der Baseline, deine Empfehlung für die nächsten Wellen und Fragen an den Menschen.
2. **Release-PR**: Ist der Basis-Branch nicht der Default-Branch (`git symbolic-ref refs/remotes/origin/HEAD`) und
   liegt er vor ihm (`git log --oneline origin/<default>..origin/<base>` ist nicht leer), öffne mit `open_pull_request`
   einen Pull Request mit `head: <base>` und `base: <default>`. Titel: `Release: Autopilot bis Welle <N>`, im Text die
   Zusammenfassung. Gibt es ihn schon, liefert das Tool ihn zurück. Gemergt wird er von einem Menschen.
3. Genau einen Kommentar `## Auto-Code Checkpoint nach Welle <N>` posten, mit dem Link zum Release-PR.
4. `set_status("In review")` und den Turn beenden. Schiebt ein Mensch das Epic zurück nach „Ready“, geht es weiter.

## Phase 7: Pause oder Übergabe

- **Nichts Sinnvolles mehr**: Kommentar `## Auto-Code Pause`. Er sagt, warum nichts mehr die Kriterien erfüllt, und was
  ein Mensch tun kann, damit es weitergeht (Projektbeschreibung erweitern, Wünsche kommentieren). Danach
  `set_status("In review")`.
- **Epic voll** (80 oder mehr Sub-Issues): Kommentar `## Auto-Code Übergabe` mit allem, was ein Nachfolger wissen muss:
  Stand, Ideen-Backlog, abgelehnte Ideen, offene Wünsche. Der Mensch legt ein neues Epic an und kopiert den Abschnitt
  unter die Befehlszeile. Danach `set_status("In review")`.

Schreibe Sub-Issues, Berichte und Kommentare in der Sprache des Epics.
