# Zuschnitt: Epics, Issues, Abhängigkeiten, Labels

Ein guter Plan ist vollständig gegenüber dem Konzept, jedes Issue einzeln mergbar, und die Reihenfolge ergibt sich aus
den Abhängigkeiten, nicht aus der Nummerierung.

## Epics

- Ein Epic ist ein **fachlich zusammenhängender, für sich lieferbarer Bereich** des Konzepts („Benutzerverwaltung“,
  „Rechnungen“), kein technischer Layer („Datenbank“, „Frontend“).
- Ein Epic hat **2 bis 10 Issues**. Ein einzelnes Issue gehört in ein anderes Epic; mehr als 10 Issues sind zwei Epics.
- Ein Grundlagen-Epic (Rollen, Mandanten, Basis-Layout) nur, wenn das Konzept es voraussetzt und mehrere Bereiche darauf
  aufbauen. Es kommt zuerst.
- Titel: `Epic: <Bereich>`. Der Text fasst das Ziel des Bereichs zusammen und verweist auf den Konzeptabschnitt. Er enthält
  **nie** „blocked by #N“ (auch nicht verneint) und nie `/`-Befehle am Anfang; Verweise auf andere Epics schreibst du als
  „baut auf #N auf“.

## Issues

- **Einzeln mergbar**: ein Pull Request, den ein Mensch in Ruhe prüfen kann. Größe S (eine Datei oder wenige Zeilen) oder M
  (wenige Dateien, ein Bereich). L teilst du.
- **Vertikale Scheibe statt Schicht**: „Rechnung anlegen“ (Migration, Model, Resource, Policy, Test) statt „alle Migrationen“.
  Tests gehören ins Issue, das den Code ändert, nicht in ein eigenes Test-Issue.
- Jedes Issue hat **prüfbare Akzeptanzkriterien** (bei Rechten: wer darf, wer nicht), sagt, welche Tests es braucht, nennt
  den **Konzeptabschnitt** und sagt, was **nicht** dazugehört.
- **Design-Issues** (der Agent sieht die Oberfläche nicht): konkrete Kriterien mit Filament-Komponente, Spalten, Filtern,
  Aktionen, Texten, Leer- und Fehlerzuständen und der Rolle, die was sieht. Nie „schöner machen“.
- Unklares bleibt eine **Frage im Bericht**, kein Issue. Das gilt auch für Entscheidungen, die ein Mensch treffen muss:
  Rechtliches, Preise, Texte mit rechtlicher Wirkung, externe Dienste mit Kosten.
- Titel: `<Feature|Design|Qualität|Wartung>: <was sich ändert>`, kurz und eindeutig. Der Titel ist der Schlüssel gegen
  Duplikate und muss unter einem Epic eindeutig sein.
- Ein Major-Upgrade (Laravel, Filament, PHP) steht allein in seinem Epic und bekommt zusätzlich `manual-merge`.
- Ein reines Refactoring ohne Verhaltensänderung beginnt mit `/refactor-safely` in der ersten Zeile (Abhängigkeiten
  stehen darunter). Fehlen im Bereich Tests, wartet es auf ein Issue, das sie schreibt.

## Abhängigkeiten

- **Nur echte Abhängigkeiten**: Issue B braucht Code oder Daten aus Issue A (Model, Rolle, Route, Migration). Gleiche
  Dateien allein sind ein Grund zum Verketten, ein gemeinsames Thema nicht.
- **Nie auf ein Epic.** Ein Epic schließt ein Mensch von Hand; es würde ewig blockieren.
- Abhängigkeiten dürfen über Epics hinweg gehen, aber nie im Kreis. Prüfe den Graphen auf Zyklen, bevor du den Plan postest.
- Kurze Ketten: Wartet ein Issue auf mehr als drei andere, ist es zu groß oder falsch geschnitten.
- Im Aufruf: `blocked_by: [<Nummern>]` setzt GitHubs Relationship. Zusätzlich steht im Text als eigene Zeile direkt unter
  dem Ziel `Blocked by #N` (mehrere: `Blocked by #3, #4`), wörtlich und Englisch, auch in deutschen Texten. Nur das erkennt
  Symphony im Text.
- Ein Issue wird erst gestartet, wenn alle Blocker **geschlossen** sind, also ihr Pull Request gemergt ist. Das schreibst
  du nicht ins Issue; es ist das Verhalten von Symphony.

## Labels

Pro Issue genau **eine** Kategorie, **ein** Effort-Label und (außer bei `issue-models=off`) **ein** Modell-Label.

**Kategorie**

| Label | Wann |
|---|---|
| `feature` | neue oder vervollständigte Funktion aus dem Konzept |
| `design` | Oberfläche und Bedienbarkeit |
| `quality` | Tests, Refactoring, Performance, Sicherheit |
| `maintenance` | Abhängigkeiten, Upgrades, Werkzeuge |

**Effort** (wie viel nachgedacht wird; Aufwand S/M und Risiko):

| Label | Wann |
|---|---|
| `Effort: low` | Texte, Übersetzungen, Konfiguration, eine Zeile |
| `Effort: medium` | Aufwand S |
| `Effort: high` | Aufwand M, der Normalfall |
| `Effort: xhigh` | Risiko hoch: Datenmodell, Rechte, Geld oder Abrechnung, Migration bestehender Daten, knifflige Abhängigkeiten |

`Effort: max` vergibst du nie von selbst. Fehlt dir ein Maßstab, nimm `Effort: high`.

**Modell** (`issue-models=auto`; bei `opus`, `sonnet`, `haiku` bekommen alle Issues dasselbe Label):

| Label | Wann |
|---|---|
| `Model: haiku` | Aufwand S **und** Risiko niedrig: Texte, Übersetzungen, Konfiguration, kleine Anpassungen in einem Bereich, einfache Tests |
| `Model: sonnet` | der Normalfall: Aufwand S mit Risiko mittel, Aufwand M mit Risiko niedrig oder mittel (neue Funktion in wenigen Dateien, Design-Issues, Tests) |
| `Model: opus` | Risiko hoch (Datenmodell, Rechte, Geld, Migrationen auf bestehenden Daten), Aufwand M über mehrere Bereiche, Major-Upgrades, knifflige Abhängigkeiten |

Im Zweifel das stärkere Modell. Aufwand und Modell hängen zusammen, sollen aber nicht blind gleich laufen: Ein Datenmodell
in einer Datei ist `Effort: xhigh` und `Model: opus`; ein Übersetzungs-Issue ist `Effort: low` und `Model: haiku`.

Epics bekommen weder Effort- noch Modell-Label: Sie werden nicht umgesetzt.
