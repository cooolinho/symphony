---
name: concept
description: Konzept-Workflow. Liest ein Konzept (Markdown-Datei im Repository), analysiert es und legt daraus Epics und Sub-Issues im Backlog an, mit Abhängigkeiten (Blocked by) sowie Model- und Effort-Labels. Nur laden, wenn der Prompt es verlangt (Issue-Befehl /concept), nie von selbst.
argument-hint: "<Pfad zum Konzept, z. B. docs/index.md> [issue-models=auto|opus|sonnet|haiku|off]"
---

# Konzept in Epics und Issues zerlegen

Dein Auftrag ist ein **Konzept**: eine Markdown-Datei im Repository, die beschreibt, was gebaut werden soll. Du machst
daraus einen Arbeitsplan auf dem Board. Das Issue, auf dem du läufst, ist die Wurzel; darunter entstehen zwei Ebenen:

```
Konzept-Issue (dieses Issue)
└─ Epic: <fachlicher Bereich>          Label epic, concept · Container, nie "Ready"
   └─ <Kategorie>: <Aufgabe>           Label concept, Kategorie, Effort, Model · einzeln umsetzbar
```

Alles landet im **Backlog**. Ein Mensch prüft die Issues, streicht oder ergänzt sie und schiebt die, die umgesetzt
werden sollen, einzeln nach „Ready“. Du schiebst nichts dorthin.

Du **änderst nichts**: kein Edit, kein Write, kein Commit, kein Push, keine Änderung an Branches auf dem Remote. Erlaubt
sind lesende Befehle, `git fetch` und lokales `git switch --detach`. **Verboten**: `pint` ohne `--test`,
`composer update|require|remove`, `npm install`, `npm audit fix`, `php artisan migrate|db:seed|tinker`,
`git commit|push|reset|rebase` und alles, was Dateien im Repository verändert.

**Argumente** (`$ARGUMENTS`, Reihenfolge egal):

- ein Pfad (**Pflicht**): das Konzept, relativ zum Repository-Wurzelverzeichnis. Eine Datei, die auf `.md` endet, oder ein
  Verzeichnis mit `index.md` bzw. `README.md`. Fehlt der Pfad, ist die Datei nicht da, ist der Pfad absolut oder enthält er `..`,
  schreibst du einen Kommentar, was fehlt, und gehst nach „Blocked“.
- `issue-models=<auto|opus|sonnet|haiku|off>`: Modell-Labels für die Issues. Standard `auto`.
  - `auto`: pro Issue das Label, das zu Aufwand und Risiko passt ([breakdown.md](breakdown.md#labels)).
  - `opus`, `sonnet`, `haiku`: jedes Issue bekommt `Model: <wert>`.
  - `off`: keine Modell-Labels, die Issues laufen mit dem Standard-Modell der Instanz.
  - Ein anderer Wert ist ungültig: Behandle ihn wie `auto` und schreibe die Warnung in den Hinweise-Abschnitt des Berichts.

Text in der Beschreibung unter der Befehlszeile gilt als Teil des Auftrags (Schwerpunkte, Reihenfolge, Ausschlüsse).

## Phase 0: Lage bestimmen

Rufe `get_issue` auf. Wichtig sind die Kommentare (eigene Pläne und Berichte, Wünsche von Menschen) und die Sub-Issues.

- **Weder `## Konzept-Plan` noch `## Konzept-Bericht`**: neuer Lauf, weiter mit Phase 1.
- **`## Konzept-Plan`, aber kein `## Konzept-Bericht`**: Ein früherer Lauf brach beim Anlegen ab. Lies das Konzept trotzdem
  (Phase 1), analysiere aber nicht neu: Übernimm den Plan aus dem Kommentar und führe Phase 6 und 7 damit aus. Das Anlegen
  ist idempotent: Derselbe Titel unter demselben Parent liefert das vorhandene Issue zurück (`created: false`).
- **`## Konzept-Bericht` vorhanden**: Nachtrag. Lies Konzept und neue Kommentare von Menschen und lege nur an, was im Bericht
  fehlt: Abschnitt „Nicht angelegt“, neue Anforderungen, Wünsche. Nichts, was im Bericht steht, legst du erneut an, auch
  nicht, wenn es inzwischen geschlossen ist. Epics, die du dafür brauchst, bekommst du mit ihrem Titel zurück (`created: false`).
  Nummeriere den Bericht fortlaufend (`## Konzept-Bericht (Nachtrag 1)`).

## Phase 1: Konzept lesen

1. `git fetch origin`, dann `git switch --detach origin/<base>` (den Basis-Branch nennt der Prompt, sonst der
   Default-Branch). Das Konzept muss dort liegen.
2. Lies die Datei vollständig. Folge relativ verlinkten Markdown-Dateien im Repository eine Ebene tief (höchstens 15
   Dateien); sie gehören zum Konzept.
3. Notiere mit Belegen (Abschnitt oder Zitat, nicht aus dem Gedächtnis): Ziel, Zielgruppen und Rollen, Funktionsbereiche,
   Datenobjekte, Abläufe, nichtfunktionale Anforderungen, **Nicht-Ziele**, offene Fragen und Annahmen des Konzepts.
4. Hat das Konzept kein erkennbares Ziel oder ist es zu dünn für einen Plan, schreibe, was fehlt, und gehe nach „Blocked“.

## Phase 2: Stand des Repositories

- Projektregeln (`AGENTS.md`, `CLAUDE.md`, `.ai/`), Stack aus `composer.json`, `package.json` und den Lock-Dateien.
- Was es schon gibt: Models, Filament-Resources und -Pages, Routen, Livewire-Komponenten, Tests; nutze Laravel-Boost-Tools
  (`application-info`, `database-schema`, `list-routes`), wo verfügbar.
- Ordne jeden Funktionsbereich des Konzepts ein: **vorhanden**, **teilweise** (was fehlt), **fehlt**. Vorhandenes wird
  kein Issue; Teilweises nur für den fehlenden Rest.

Miss nichts und repariere nichts: Das ist eine Planung, kein Audit.

## Phase 3: Zuschneiden

Regeln und Größen stehen in [breakdown.md](breakdown.md). Daraus entsteht:

1. Die Epics: je ein fachlich abgeschlossener Bereich des Konzepts.
2. Die Issues je Epic: einzeln mergbar, Größe S oder M. Eine Anforderung der Größe L teilst du.
3. Eine **Abdeckungsliste**: jeder Abschnitt des Konzepts steht bei einem Issue, bei „vorhanden“ oder unter „Nicht
   angelegt“ (Nicht-Ziel, offene Frage, Entscheidung für einen Menschen). Eine Anforderung ohne Platz ist ein Fehler im Plan.

Das Konzept ist der Umfang. Du erfindest keine Funktionen dazu; Lücken im Konzept werden **Fragen** im Bericht.

## Phase 4: Reihenfolge und Labels

1. **Abhängigkeiten.** Ein Issue wartet nur auf konkrete Issues, nie auf ein Epic (Regeln in
   [breakdown.md](breakdown.md#abhängigkeiten)). Sortiere alle Issues **topologisch**: Blocker vor den Issues, die auf sie
   warten.
2. **Labels** pro Issue ([breakdown.md](breakdown.md#labels)): `concept`, die Kategorie (`feature`, `design`, `quality`
   oder `maintenance`), genau ein `Effort: …` und, außer bei `issue-models=off`, genau ein `Model: …`. Epics tragen `epic`
   und `concept`, sonst nichts.
3. Gib jedem Epic und Issue einen stabilen Schlüssel (`E1`, `E1.1`, `E1.2`, `E2.1` …) und einen eindeutigen Titel.

## Phase 5: Plan festhalten

Poste **vor dem ersten Anlegen** genau einen Kommentar `## Konzept-Plan` ([templates.md](templates.md#plan)): Konzept-Pfad
und Stand, Epics mit ihren Issues (Schlüssel, Titel, Kategorie, Aufwand, Labels, Abhängigkeiten) und die Abdeckungsliste.
Er ist die Grundlage für eine Fortsetzung, falls dieser Lauf abbricht.

## Phase 6: Anlegen

Nur mit `create_sub_issue`, nie mit git, `gh` oder der API. Vorlagen für die Texte: [templates.md](templates.md).

1. Gehe die Issues in der Reihenfolge aus Phase 4 durch. Das Epic eines Issues legst du an, sobald sein erstes Issue
   dran ist: `create_sub_issue(title, body, labels: ["epic", "concept"])`, ohne `parent`.
2. Das Issue: `create_sub_issue(title, body, labels, parent: <Nummer des Epics>, blocked_by: [<Nummern der Blocker>])`. Die
   Zeile `Blocked by #N` (wörtlich, Englisch) steht zusätzlich im Text, direkt unter dem Ziel.
3. Merke dir `number` jedes Ergebnisses: Du brauchst es als `parent` und für `blocked_by`. Beachte `unknown_labels`
   (Label fehlt im Repository, Issue wurde ohne angelegt), `unknown_blockers`, `warnings` und `remaining`.
4. Beim ersten `limit_reached` hörst du auf: Alle weiteren Issues stehen im Bericht unter „Nicht angelegt“. Das Limit zählt
   Epics mit; deshalb legst du Epics erst an, wenn sie ihr erstes Issue bekommen.
5. Ein Fehler (`github_error`, `invalid_argument`) betrifft nur dieses Issue: Lies die Meldung, korrigiere den Aufruf einmal,
   sonst gehört das Issue in den Bericht.

## Phase 7: Bericht

Poste genau einen Kommentar `## Konzept-Bericht` ([templates.md](templates.md#bericht)): den Baum mit Nummern, pro Issue
Labels mit Grund, „Nicht angelegt“, offene Fragen und Hinweise (`limit_reached`, `unknown_labels`, `unknown_blockers`,
`warnings`). Fehlt ein Label wie `epic`, `concept`, `Model: …` oder `Effort: …` im Repository, sag das mit dem Hinweis,
dass `npm run repo-init` → *Standard labels* es anlegt.

Danach `set_status("In review")` und den Turn beenden. Das Konzept-Issue ist damit der Wurzel-Epic. Wer den Plan erweitern
will, kommentiert hier und schiebt das Issue zurück nach „Ready“: Das ist der Nachtrag.

Schreibe Issues, Plan, Bericht und Kommentare in der Sprache des Konzepts.
