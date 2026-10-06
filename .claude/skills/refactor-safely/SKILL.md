---
name: refactor-safely
description: Verhaltensneutrales Refactoring mit Tests als Sicherheitsnetz, für Entwickler und Reviewer. Nur laden, wenn der Prompt es verlangt (Issue beginnt mit /refactor-safely), nie von selbst.
argument-hint: "[optionaler Hinweis]"
---

# Refactoring ohne Verhaltensänderung

Ein Refactoring ändert die Struktur, nicht das Verhalten. Was das Projekt vorher nach außen tat, tut es danach
genauso: gleiche Antworten, gleiche Daten, gleiche Fehler. Tests beweisen das. Welche Rolle du hast, steht im Prompt
(„Your role: developer“ oder „reviewer“). Lies den Abschnitt für deine Rolle und die Regeln für alle.

## Regeln für alle

**Verhalten bleibt gleich.** Nicht ändern, außer das Issue verlangt es ausdrücklich:

- Routen, URLs, HTTP-Statuscodes, Antwortformate
- Öffentliche Signaturen, die von anderswo genutzt werden (Klassen, Methoden, Events, Jobs, Artisan-Befehle)
- Datenbankschema und gespeicherte Daten (keine Migration, außer das Issue verlangt sie)
- Config-Schlüssel, Umgebungsvariablen, Berechtigungen und Validierungsregeln
- Texte und Übersetzungen, die Benutzer sehen

**Bugs gehören nicht hierher.** Entdeckst du beim Refactoring einen Bug, behebe ihn nicht in diesem Pull Request.
Beschreibe ihn im Issue-Kommentar mit Datei und Zeile; ein eigenes Issue erstellt ein Mensch.

**Tests sind das Sicherheitsnetz.** Bestehende Tests werden nicht abgeschwächt, übersprungen oder gelöscht, und ihre
Assertions bleiben unverändert. Wenn ein bestehender Test rot wird, hast du das Verhalten geändert: Mach die
Änderung rückgängig, statt den Test anzupassen.

**Verifiziere gegen die installierte Version.** Prüfe Framework-APIs mit Boost `search-docs`, nicht aus dem Gedächtnis;
Filament, Livewire und Laravel unterscheiden sich zwischen den Major-Versionen stark. Folge `AGENTS.md`, `.ai/` und den
Konventionen des Projekts.

## Entwickler

1. Lies das Issue, das Audit-Epic (Parent) und die genannten Dateien. Prüfe die Abhängigkeiten: Wartet das Issue noch
   auf ein Test-Issue (`Blocked by #N`), das nicht geschlossen ist, melde das und setze `Blocked`.
2. **Sicherheitsnetz zuerst.** Prüfe, ob der Bereich Tests hat, die das Verhalten wirklich festhalten
   (siehe [characterization-tests.md](characterization-tests.md)). Fehlen sie, schreibe sie, **bevor** du Produktivcode anfasst.
   Sie müssen auf dem unveränderten Code grün sein. Committe sie getrennt („Tests: … absichern“).
3. Steht im Issue „nur Characterization-Tests“, ist hier Schluss: kein Produktivcode, weiter mit Schritt 6.
4. Refactore in kleinen Schritten. Nach jedem Schritt laufen die betroffenen Tests, dann ein Commit pro sinnvoller
   Einheit (Umbenennen, Extrahieren, Verschieben getrennt halten).
5. Zum Schluss die ganze Test-Suite und die Projektprüfungen (Pint, Analyse). Alle bestehenden Tests sind
   unverändert grün; im Test-Diff stehen nur neue Dateien oder neue Zeilen.
6. Beschreibe im Pull Request und im Issue-Kommentar: was umgebaut wurde, welche Tests das Verhalten sichern, was
   sich **nicht** geändert hat. Gibt es Abweichungen vom Ziel, nenne sie offen.

## Reviewer

Du bist read-only und arbeitest über Diffs. Gehe die [review-checklist.md](review-checklist.md) durch. Kurz:

1. `git diff origin/<base>...HEAD -- tests/`: Es dürfen nur Zeilen hinzukommen. Entfernte oder geänderte Assertions,
   neue `skip`/`todo`/`markTestSkipped`, gelockerte Erwartungen: **blocker**.
2. Diff auf `routes/`, `config/`, `database/migrations/`, `app/Events`, `app/Policies`, Validierung und Übersetzungen:
   jede Änderung ohne Auftrag im Issue ist ein **blocker**.
3. Prüfe, ob die neuen Tests das Verhalten wirklich festhalten (Antworten, Datenbankzustand, Fehlerfälle) und nicht nur,
   dass etwas aufgerufen wird.
4. Prüfe, dass nichts Fremdes mitgekommen ist: Bugfixes, Formatierungsrauschen in unbeteiligten Dateien, Konfigurationsänderungen.
5. Melde Befunde im üblichen Format des Reviews. Ein Refactoring mit Verhaltensänderung ist **changes needed**, auch
   wenn die Änderung gut gemeint ist.
