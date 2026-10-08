# Vorlagen

Schreibe in der Sprache des Epics. Die folgenden Vorlagen sind deutsch. Titel kurz und eindeutig: Der Titel dient
zugleich als Schlüssel, damit ein Retry kein Duplikat anlegt. Pfade und Nummern sind Platzhalter.

## Sub-Issue

Titel: `<Feature|Design|Qualität|Wartung>: <was sich ändert>`, z. B. `Feature: CSV-Export der Abrechnungen`.
Labels: `auto-code`, Kategorie, `Effort: medium|high`, ggf. `manual-merge`.

```markdown
## Ziel
<Was Nutzer danach können oder was danach besser ist, in ein bis zwei Sätzen.>

## Bezug zur Projektbeschreibung
<Abschnitt oder Zitat aus der Projektbeschreibung / dem Roadmap-Punkt, den dieses Issue voranbringt.>

## Ausgangslage
`<Datei>:<Zeile>` / `<Route>` / `<Resource>`: <was es heute gibt oder fehlt>

## Akzeptanzkriterien
- [ ] <prüfbares Kriterium>
- [ ] <prüfbares Kriterium, inkl. Rechte: wer darf, wer nicht>

## Tests
- <Feature-, Livewire- oder Filament-Test, der die Kriterien belegt>

## Hinweise
<Betroffene Bereiche, was nicht geändert werden soll, ggf. „Roadmap-Punkt `<…>` in `docs/todo.md` abhaken“.>

Kategorie: <feature|design|quality|maintenance> · Aufwand: <S|M> · Risiko: <niedrig|mittel|hoch> ·
Teil von Welle <N> des Autopiloten #<Epic>.
```

Abhängigkeiten stehen als eigene Zeile direkt unter dem Ziel: `Blocked by #<n>`. Ein reines Refactoring beginnt mit
`/refactor-safely` in der ersten Zeile.

## Wellen-Bericht

```markdown
## Auto-Code Welle <N>

**Stand:** `<base>` @ <kurzer Commit-Hash> · **Projektbeschreibung:** `<Pfad>`

### Baseline
- Tests: <Ergebnis> · Analyse: <Ergebnis> · Pint: <Ergebnis>

### Diese Welle
- [ ] #<n> <Titel> (<Kategorie>, <Aufwand>, Risiko <…>): <warum jetzt, Bezug zur Beschreibung>
- [ ] #<n> <Titel> … *wartet auf #<m>*

### Berücksichtigte Wünsche
- <Kommentar von @…>: <umgesetzt in #n | später, weil … | nicht, weil …>

### Ideen-Backlog (nicht angelegt)
1. <Idee> (<Kategorie>, Nutzen <…>, Aufwand <…>): <warum noch nicht>

### Hinweise
<Abgelehnte Anlagen (`limit_reached`), unbekannte Labels, Beobachtungen.>

Nächste Welle, sobald alle Issues dieser Welle geschlossen sind. Steuern: Wünsche als Kommentar hier im Epic. Eine Idee
ablehnen: das Sub-Issue als „not planned“ schließen. Stoppen: das Epic nach Backlog verschieben.
```

## Checkpoint

```markdown
## Auto-Code Checkpoint nach Welle <N>

**Release-PR:** #<n> (`<base>` → `<default>`) · **Wellen:** <von>–<N>

### Erledigt
- #<n> <Titel>

### Abgelehnt
- #<n> <Titel>: <was daraus folgt>

### Zustand
<Baseline, Testabdeckung der neuen Teile, Auffälligkeiten.>

### Ideen-Backlog
1. <Idee>: <Nutzen, Aufwand>

### Empfehlung für die nächsten Wellen
<Schwerpunkte, Risiken, was du anders machen würdest.>

### Fragen
- <Entscheidung, die ein Mensch treffen sollte>

Zum Weitermachen das Epic zurück nach „Ready“ schieben. Wünsche und Antworten als Kommentar hier.
```

## Pause und Übergabe

```markdown
## Auto-Code Pause

<Warum keine Idee die Kriterien erfüllt.> Weiter geht es, wenn die Projektbeschreibung neue Ziele bekommt oder hier
Wünsche stehen; dann das Epic zurück nach „Ready“ schieben.
```

```markdown
## Auto-Code Übergabe

Dieses Epic hat <n> Sub-Issues (GitHub erlaubt 100). Neues Epic anlegen, Beschreibung:
`/auto-code <Argumente>`, darunter diesen Abschnitt einfügen.

### Stand
<Welle N, Basis-Branch, letzter Release-PR.>

### Ideen-Backlog
1. <Idee>

### Abgelehnt (nicht erneut vorschlagen)
- <Idee>

### Offene Wünsche
- <Wunsch>
```
