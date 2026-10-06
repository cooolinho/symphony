# Vorlagen

Schreibe in der Sprache des Epics. Die folgenden Vorlagen sind deutsch. Titel kurz und eindeutig (der Titel dient zugleich
als Schlüssel, damit ein Retry kein Duplikat anlegt). Pfade und Nummern sind Platzhalter.

## Sub-Issue: Characterization-Tests

Titel: `Tests: <Bereich> absichern`

```markdown
/refactor-safely

Nur Characterization-Tests (Schritt 1 des Skills), **kein Produktivcode**.

## Bereich
`<Pfad>`: <was der Code tut, in einem Satz>

## Zu sichern
- <Verhalten 1, das die Tests festhalten, so wie es heute ist>
- <Verhalten 2>

## Hinweise
<Datenbank/Fakes/Besonderheiten>

Teil des Refactoring-Audits #<Epic>.
```

## Sub-Issue: Refactoring

Titel: `Refactoring: <Bereich> – <Ziel>`

```markdown
/refactor-safely

Blocked by #<Test-Sub-Issue>

## Befund
`<Datei>:<Zeile>`: <Problem, belegt>

## Ziel
<Zustand nach dem Refactoring, ohne Verhaltensänderung>

## Vorgehen
1. <Schritt>
2. <Schritt>

## Nicht ändern
<Öffentliche Schnittstellen, die gleich bleiben: Routen, Signaturen, Events, Config-Schlüssel, Schema>

Schwere: <kritisch|hoch|mittel|niedrig> · Aufwand: <S|M|L> · Teil des Refactoring-Audits #<Epic>.
```

## Sub-Issue: Bug

Titel: `Bug: <Symptom>` · Label `bug` · **Kein Befehl in der ersten Zeile.**

```markdown
## Fehler
`<Datei>:<Zeile>`: <was falsch ist>

## Nachweis
<Wie er auftritt: Eingabe, Ablauf, Log oder Testausgabe>

## Erwartet
<Richtiges Verhalten>

## Vorgehen
Zuerst einen Regressionstest schreiben, der **fehlschlägt** (rot), dann den Fehler beheben (grün). Den Fix nicht mit
Refactorings mischen.

Schwere: <kritisch|hoch|mittel|niedrig> · Teil des Refactoring-Audits #<Epic>.
```

## Report-Kommentar

```markdown
## Refactoring-Audit

**Scope:** <Pfad oder „gesamtes Repository“> · **Stand:** <kurzer Commit-Hash>

### Kontext
PHP <x> · Laravel <x> · Filament <x> · Livewire <x> · Pest/PHPUnit <x> · Vite <x> · Node <x> · Boost <ja/nein>

### Baseline
- Tests: <Ergebnis>
- Statische Analyse: <Ergebnis>
- Pint: <Ergebnis>
- composer audit / npm audit: <Ergebnis>
- Build: <Ergebnis>

### Sub-Issues
- [ ] #<n> <Titel> (<Schwere>, <Aufwand>)
- [ ] #<n> <Titel> … *wartet auf #<m>*

### Nicht angelegt
- <Befund>: <warum nicht (Limit, zu klein, zu unsicher)>

### Unklar
- <Vermutung ohne Beleg und was zur Klärung nötig wäre>

Die Sub-Issues stehen im Backlog. Zum Umsetzen eines Sub-Issues in „Ready“ verschieben.
```
