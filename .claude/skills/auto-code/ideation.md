# Ideen finden und bewerten

Ziel ist ein Projekt, das seiner Beschreibung näherkommt, nicht ein Projekt mit möglichst vielen Funktionen. Eine gute
Welle ist klein, belegt und mergebar.

## Kategorien

| Label | Inhalt | Beispiele |
|---|---|---|
| `feature` | Neue oder vervollständigte Funktion aus der Projektbeschreibung oder Roadmap | Export einer Liste, fehlender Freigabeschritt, Benachrichtigung |
| `design` | Oberfläche und Bedienbarkeit | Dashboard-Widget, verständlichere Formulare, Leer-Zustände, konsistente Tabellen |
| `quality` | Bugs, fehlende Tests, Refactoring, Performance, Sicherheit | N+1 beheben, Policy ergänzen, Tests für einen ungetesteten Ablauf |
| `maintenance` | Abhängigkeiten, Upgrades, Werkzeuge | Minor-Updates, veraltete API ersetzen, Deprecations |

## Bewertung

Jede Idee bekommt drei Werte:

| | hoch | mittel | niedrig |
|---|---|---|---|
| **Nutzen** | schließt eine Lücke zum Ziel der Projektbeschreibung oder einen offenen Wunsch | verbessert einen häufig genutzten Ablauf spürbar | nett, aber selten gebraucht |
| **Risiko** | Datenmodell, Rechte, Geld oder Abrechnung, Migrationen auf bestehenden Daten | mehrere Bereiche, neue Abhängigkeit | ein Bereich, gut testbar |

**Aufwand:** S (eine Datei oder wenige Zeilen) · M (wenige Dateien, ein Pull Request) · L (teilen, nie als Ganzes).

Auswahl: Nutzen hoch vor mittel. Bei gleichem Nutzen gewinnt das geringere Risiko, dann der geringere Aufwand. Ideen mit
niedrigem Nutzen kommen nur ins Ideen-Backlog.

## Mischregeln

1. Wünsche von Menschen und offene Roadmap-Punkte gehen eigenen Ideen vor.
2. Höchstens **ein** `maintenance`-Issue pro Welle. Ein Major-Upgrade steht allein in seiner Welle und trägt
   `manual-merge`.
3. Jede **dritte** Welle (3, 6, 9 …) enthält mindestens ein `quality`-Issue. Bei roter Baseline besteht die ganze Welle
   aus `quality`-Issues.
4. **Design-Sperre:** Ein Bereich (eine Resource, eine Seite, ein Panel), der in den letzten drei Wellen ein
   `design`-Issue hatte, bekommt kein weiteres. Das verhindert, dass dieselbe Oberfläche immer wieder umgebaut wird.
5. Höchstens ein Issue mit Risiko „hoch“ pro Welle. Migrationen auf bestehenden Daten brauchen einen reversiblen
   `down()` und Tests.

## Leitplanken gegen Drift

- **Belegpflicht.** Jede Idee nennt den Abschnitt der Projektbeschreibung, den sie voranbringt, und die Stelle im Code,
  an der sie ansetzt. Fehlt eins von beiden, wird sie nicht angelegt.
- **Nicht-Ziele und Tabus** aus den Leitplanken gelten absolut, ebenso abgelehnte Sub-Issues (`NOT_PLANNED`), auch in
  anderer Formulierung.
- **Keine neuen Abhängigkeiten** (Composer, npm) ohne klaren Grund. Den Grund nennst du im Issue.
- **Keine Querschnitts-Umbauten** (anderes Framework, neue Architektur, Umbenennungen quer durchs Projekt). Solche Ideen
  gehören in den Checkpoint-Bericht als Frage an den Menschen.
- **Kein Ersatz für Entscheidungen**: Rechtliches, Preise, Texte mit rechtlicher Wirkung und externe Dienste mit Kosten
  schlägst du im Bericht vor, legst sie aber nicht als Issue an.
- **Lieber pausieren als füllen.** Erfüllt keine Idee die Kriterien, ist eine Pause (Phase 7) das richtige Ergebnis.

## Design-Issues

Der Agent sieht die Oberfläche nicht. Deshalb gilt für `design`:

- Konkrete, prüfbare Kriterien: welche Filament-Komponente, welche Spalten, Filter, Aktionen, Texte, Leer- und
  Fehler-Zustände, welche Rolle was sieht.
- Bestehende Bausteine des Projekts verwenden (Filament-Komponenten, Theme, vorhandene Muster), keine eigenen
  CSS-Lösungen, wenn Filament es kann.
- Ein Feature- oder Livewire-Test, der das Ergebnis belegt (Seite rendert, Aktion sichtbar für Rolle X, nicht für Y).
- Design-Prinzipien aus den Leitplanken beachten. Fehlen sie, gelten Konsistenz mit dem Bestand und Barrierefreiheit
  (Labels, Kontrast, Tastaturbedienung).
