# Review-Checkliste: Refactoring ohne Verhaltensänderung

Arbeite über Diffs (`git diff origin/<base>...HEAD`), du bist read-only. Pro Zeile: OK, n/a oder ein Befund.

## Tests (Sicherheitsnetz)

- [ ] `git diff origin/<base>...HEAD -- tests/` enthält **nur hinzugefügte** Zeilen oder neue Dateien. Jede entfernte oder geänderte Assertion ist ein blocker.
- [ ] Keine neuen `skip`, `todo`, `markTestSkipped`, `->only()`; keine gelockerten Erwartungen (`assertOk` statt `assertJson`, kleinere Treffermengen).
- [ ] Das Test-Setup (Factories, `phpunit.xml`, Pest-Konfiguration, CI) ist unverändert, außer das Issue verlangt es.
- [ ] Neue Tests halten Verhalten fest: Antwort, Datenbankzustand, Fehlerfall, Autorisierung. Sie prüfen nicht nur, dass etwas aufgerufen wurde.
- [ ] Hatte der Bereich vorher keine Tests, kamen sie in einem **eigenen Commit vor** dem Umbau (`git log --oneline`).

## Verhalten

- [ ] `routes/`: keine Route hinzugefügt, entfernt oder umbenannt, Middleware gleich.
- [ ] `config/` und Umgebungsvariablen unverändert.
- [ ] `database/migrations/` unverändert, außer das Issue verlangt eine Migration; keine Änderung an Modell-Casts, `$fillable`, `$guarded`, Relationen mit Wirkung nach außen.
- [ ] Öffentliche Signaturen (Rückgabetyp, Parameter, Sichtbarkeit) und Events, Jobs, Artisan-Befehle gleich oder abwärtskompatibel; alle Aufrufer geprüft (`grep`).
- [ ] Validierung, Policies, Filament-Autorisierung (`canViewAny`, `canEdit` …) und Übersetzungstexte unverändert.
- [ ] Reihenfolge und Menge von Ergebnissen gleich (Sortierung, `limit`, `with`), keine neuen Abfragen in Schleifen.

## Umfang

- [ ] Nur der im Issue genannte Bereich wurde angefasst; kein Formatierungsrauschen in fremden Dateien.
- [ ] Kein Bugfix im selben Pull Request. Wurde einer entdeckt, steht er als Hinweis im Kommentar.
- [ ] Commits klein und beschrieben; Umbenennen, Verschieben und Extrahieren nicht in einem Commit vermischt.
- [ ] Entry-Checks (Lint, Analyse, Tests) sind grün; nichts wurde dafür abgeschwächt.

## Ergebnis

- **approved**: keine blocker oder major Befunde.
- **changes needed**: jede Verhaltensänderung, jede abgeschwächte Assertion, jeder Fremdinhalt.
