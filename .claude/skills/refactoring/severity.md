# Bewertung

Jeder Befund bekommt **Schwere** und **Aufwand**. Daraus folgt die Reihenfolge der Sub-Issues.

## Schwere

| Stufe | Kriterium | Beispiele |
|---|---|---|
| kritisch | Datenverlust, Sicherheitslücke oder Ausfall in normaler Nutzung | fehlende Autorisierung auf schreibender Aktion, Mass Assignment mit Benutzereingabe |
| hoch | falsches Verhalten in häufigem Pfad, oder deutlich messbarer Schaden | N+1 in einer Listenansicht, nicht idempotenter Job mit Doppelwirkung |
| mittel | falsch in seltenen Fällen, oder echte Wartungsbremse | Zeitzonen-Fehler, 400-Zeilen-Controller in oft geänderter Stelle |
| niedrig | Lesbarkeit, Konsistenz, kleine Veraltungen | doppelte Hilfsfunktion, veraltete Schreibweise einer API |

## Aufwand

| Stufe | Richtwert |
|---|---|
| S | eine Datei oder wenige Zeilen, ein Test genügt |
| M | wenige Dateien, ein Pull Request, einige Tests |
| L | viele Dateien oder Tests fehlen; **in kleinere Sub-Issues teilen**, sonst nicht anlegen |

## Auswahl

1. Kritisch und hoch zuerst, unabhängig vom Aufwand.
2. Danach mittlere Befunde mit Aufwand S oder M, die zusammenhängende Bereiche entlasten.
3. Niedrige Befunde nur gebündelt (ein Sub-Issue „Aufräumen in …“) oder gar nicht.
4. Bereiche ohne Tests: Das Test-Sub-Issue hat Vorrang vor dem Refactoring, das davon abhängt.
