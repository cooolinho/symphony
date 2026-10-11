# Vorlagen

Schreibe in der Sprache des Konzepts. Die folgenden Vorlagen sind deutsch. Titel kurz und eindeutig: Der Titel dient
zugleich als Schlüssel, damit ein Retry kein Duplikat anlegt. Pfade, Nummern und Schlüssel sind Platzhalter.

## Epic

Titel: `Epic: <Bereich>` · Labels: `epic`, `concept` · Aufruf ohne `parent`.

```markdown
## Ziel
<Was dieser Bereich nach Abschluss leistet, in zwei bis drei Sätzen.>

## Bezug zum Konzept
`<Pfad>` – <Abschnitt oder Zitat>

## Inhalt
<Die Issues stehen als Sub-Issues darunter. Hier nur, was sie verbindet: Reihenfolge, gemeinsame Entscheidungen.>
<Verweise auf andere Epics: "baut auf #<n> auf".>

## Nicht enthalten
<Was zum Bereich gehört, aber bewusst nicht in diesem Epic steht, mit Verweis.>

Dieses Issue ist ein Container: Es bleibt im Backlog und wird nicht umgesetzt. Schließen, wenn alle Sub-Issues erledigt
sind. Teil des Konzepts #<Konzept-Issue>.
```

## Sub-Issue

Titel: `<Feature|Design|Qualität|Wartung>: <was sich ändert>`, z. B. `Feature: Rechnung anlegen`.
Labels: `concept`, Kategorie, `Effort: …`, ggf. `Model: …`, ggf. `manual-merge`. Aufruf mit `parent` (Nummer des Epics) und
`blocked_by`.

```markdown
## Ziel
<Was Nutzer danach können oder was danach besser ist, in ein bis zwei Sätzen.>

Blocked by #<n>

## Bezug zum Konzept
`<Pfad>` – <Abschnitt oder Zitat>

## Ausgangslage
`<Datei>:<Zeile>` / `<Route>` / `<Resource>`: <was es heute gibt oder fehlt; bei Neuem: wo es anknüpft>

## Akzeptanzkriterien
- [ ] <prüfbares Kriterium>
- [ ] <prüfbares Kriterium, inkl. Rechte: wer darf, wer nicht>

## Tests
- <Feature-, Livewire- oder Filament-Test, der die Kriterien belegt>

## Nicht enthalten
<Was bewusst zu einem anderen Issue gehört, mit Verweis „siehe #<n>“, und was nicht geändert werden soll.>

Kategorie: <feature|design|quality|maintenance> · Aufwand: <S|M> · Risiko: <niedrig|mittel|hoch> ·
Teil von Epic #<Epic> im Konzept #<Konzept-Issue>.
```

Die Zeile `Blocked by #<n>` steht nur bei Issues mit Abhängigkeit und direkt unter dem Ziel. Ein reines Refactoring beginnt
mit `/refactor-safely` in der ersten Zeile, darunter folgt `Blocked by`.

## Plan

```markdown
## Konzept-Plan

**Konzept:** `<Pfad>` @ `<base>` <kurzer Commit-Hash> · **issue-models:** <auto|opus|sonnet|haiku|off>

### Epics und Issues
- **E1 Epic: <Bereich>**: <ein Satz>
  - E1.1 <Titel> (<Kategorie>, <S|M>, Risiko <…>; `Effort: …`, `Model: …`)
  - E1.2 <Titel> (…) *wartet auf E1.1*
- **E2 Epic: <Bereich>**
  - E2.1 <Titel> (…) *wartet auf E1.2*

### Reihenfolge des Anlegens
E1.1, E1.2, E2.1, …

### Abdeckung
| Konzeptabschnitt | Issue |
|---|---|
| <Abschnitt> | E1.1, E1.2 |
| <Abschnitt> | vorhanden (`<Datei>`) |
| <Abschnitt> | nicht angelegt: <Grund> |

### Annahmen und Fragen
- <Annahme oder offene Frage>
```

## Bericht

```markdown
## Konzept-Bericht

**Konzept:** `<Pfad>` @ `<base>` <kurzer Commit-Hash>

### Angelegt (Backlog)
- [ ] #<n> **Epic: <Bereich>**
  - [ ] #<n> <Titel> (<Kategorie>, <S|M>, `Effort: …`, `Model: …`): <Grund für Effort und Modell in einem Halbsatz>
  - [ ] #<n> <Titel> (…) *wartet auf #<m>*
- [ ] #<n> **Epic: <Bereich>**
  - …

### Nicht angelegt
- <Anforderung>: <Grund: vorhanden, Nicht-Ziel, offene Frage, Limit>

### Offene Fragen
- <Entscheidung, die ein Mensch treffen sollte, und was davon abhängt>

### Hinweise
<`limit_reached`, unbekannte Labels (`unknown_labels`), `unknown_blockers`, `warnings`, ungültige Argumente.>

Alle Issues stehen im Backlog. Prüfen, streichen oder ergänzen und einzeln nach „Ready“ schieben: Ein Issue mit
offenem „Blocked by“ wartet in „Ready“, bis seine Blocker geschlossen sind. Die Epics bleiben im Backlog und werden
geschlossen, wenn ihre Sub-Issues erledigt sind. Erweitern: Kommentar hier, dann dieses Issue zurück nach „Ready“.
```

Beim Nachtrag lautet die Überschrift `## Konzept-Bericht (Nachtrag <n>)` und der Abschnitt „Angelegt“ nennt nur die neuen
Issues.
