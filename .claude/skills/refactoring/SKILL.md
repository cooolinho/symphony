---
name: refactoring
description: Refactoring-Audit für ein Laravel-/Filament-Repository. Ermittelt den Projekt-Kontext, misst die Baseline, findet Bugs und Refactoring-Kandidaten und legt daraus Sub-Issues an. Nur laden, wenn der Prompt es verlangt (Issue-Befehl /refactoring), nie von selbst.
argument-hint: "[Scope, z. B. app/Filament]"
---

# Refactoring-Audit

Du analysierst das Repository und machst aus den Befunden Sub-Issues des aktuellen Issues (das Epic). Du **änderst nichts**:
kein Edit, kein Write, kein Commit, kein Push, kein Pull Request. Umgesetzt wird später, in den Sub-Issues, nach Freigabe
durch einen Menschen.

Scope: `$ARGUMENTS` (leer = ganzes Repository). Bei einem Scope analysierst du nur diesen Pfad, liest aber umliegenden
Code, soweit du ihn zum Verstehen brauchst.

Erlaubt sind lesende Befehle und Messungen. **Verboten**: `pint` ohne `--test`, `composer update|require|remove`,
`npm audit fix`, `npm install`, `php artisan migrate|db:seed|tinker`, `git commit|push|checkout` und alles, was Dateien
im Repository verändert. Schreibt ein Testlauf Dateien (Cache, SQLite), ist das in Ordnung, solange sie nicht ins
Repository gehören.

## Phase 0: Fortsetzen oder neu beginnen

Rufe `get_issue` auf. Gibt es schon einen Kommentar, der mit `## Refactoring-Audit` beginnt, oder Sub-Issues, setzt ein
früherer Lauf hier fort (Abbruch, Budget, Retry). Dann beginnst du **nicht** von vorn:

- Report vorhanden → prüfe nur, ob alle darin genannten Sub-Issues existieren; lege fehlende an, dann `set_status("In review")`.
- Nur Sub-Issues vorhanden → analysiere nur die Bereiche, die noch kein Sub-Issue abdeckt, und schreibe danach den Report.

`create_sub_issue` ist idempotent: Derselbe Titel liefert das vorhandene Issue zurück.

## Phase 1: Projekt-Kontext

Ermittle und notiere (Belege aus den Dateien, nicht aus dem Gedächtnis):

- **PHP, Laravel, Filament, Livewire, Test-Framework (Pest/PHPUnit), Larastan, Pint** aus `composer.lock` und `composer.json`.
- **Node, Vite, Tailwind, Alpine** und weitere Frontend-Pakete aus `package.json` und der Lock-Datei, dazu `vite.config.*`.
- Boost-Tool `application-info`, falls verfügbar: PHP-/Laravel-Version, Pakete, Models.
- Projektregeln: `CLAUDE.md`, `AGENTS.md`, `.ai/` (Guidelines, Rules, Skills).
- Struktur: Panels und Resources unter `app/Filament`, Livewire-Komponenten, Jobs, Policies, `routes/`.

Steht Boost nicht zur Verfügung (kein `laravel/boost`), halte das im Report fest und prüfe API-Fragen anhand der
installierten Pakete in `vendor/`.

## Phase 2: Baseline messen

Miss nur, repariere nichts. Nutze zuerst die Skripte aus `composer.json` (`test`, `lint`, `analyse` …), sonst:
`php artisan test` (oder `vendor/bin/pest`), `vendor/bin/phpstan analyse`, `vendor/bin/pint --test`, `composer audit`,
`npm audit`, `npm run build`. Pro Befehl: Ergebnis in einer Zeile (grün, rot mit Anzahl, nicht vorhanden). Rote Tests
und Analysefehler sind Befunde, keine Hindernisse. Ohne Tests im betroffenen Bereich gilt Phase 4, Regel 3.

## Phase 3: Analyse

Erfasse **Bugs** und **Refactoring-Kandidaten** getrennt. Ein Bug ist ein Verhalten, das nachweislich falsch ist oder
sicher bricht. Alles andere (Struktur, Duplikate, Lesbarkeit, veraltete APIs) ist ein Refactoring-Kandidat.

- Die Kriterien stehen in [checklist.md](checklist.md), die Bewertung in [severity.md](severity.md).
- Prüfe APIs gegen die **installierte** Version mit Boost `search-docs`. Besonders Filament unterscheidet sich zwischen
  v3, v4 und v5 stark; was in einer Version richtig ist, kann in der anderen falsch sein.
- Nutze `database-schema`, `list-routes`, `last-error` und `read-log-entries`, wo sie Behauptungen belegen.
- Lies die Boost-Skills des Projekts (`laravel-best-practices`, `filament-development`, `testing-best-practices`), soweit vorhanden.
- Jeder Befund braucht einen Beleg: Datei und Zeile, bei Bugs zusätzlich, wie er auftritt. Vermutungen kommen nicht
  in ein Sub-Issue. Schreib sie in den Report unter „Unklar“.
- Bei großen Repositories teilst du die Analyse nach Bereichen auf (z. B. `app/Filament`, `app/Models`, `resources/js`)
  und lässt read-only Subagents (`symphony:architect`, `symphony:code-reviewer`) je einen Bereich prüfen. Du prüfst
  ihre Befunde selbst gegen den Code, bevor du sie übernimmst.

## Phase 4: Priorisieren und zuschneiden

1. Höchstens so viele Sub-Issues, wie `create_sub_issue` zulässt; weniger ist besser. Das Wichtigste zuerst, den Rest
   nennst du im Report unter „Nicht angelegt“.
2. Jedes Sub-Issue ist **einzeln mergebar** und klein genug für einen Pull Request, den ein Mensch in Ruhe prüfen kann.
   Gleichartige Kleinigkeiten fasst du zu einem Sub-Issue zusammen.
3. Liegt ein Refactoring in einem Bereich ohne ausreichende Tests, bekommt dieser Bereich **zuerst** ein Sub-Issue nur
   für Characterization-Tests. Das Refactoring wartet darauf (`Blocked by #N`).
4. Bugfixes sind eigene Sub-Issues und werden nie in ein Refactoring gemischt: Ein Fix ändert Verhalten, ein
   Refactoring darf das nicht.

## Phase 5: Ausgabe

Die Vorlagen stehen in [templates.md](templates.md). Reihenfolge, weil spätere Sub-Issues auf frühere verweisen:

1. Sub-Issues für Characterization-Tests anlegen und die Nummern notieren.
2. Refactoring-Sub-Issues anlegen. **Erste Zeile des Bodys: `/refactor-safely`.** Abhängigkeiten schreibst du wörtlich
   als `Blocked by #N` (Englisch, auch in deutschen Texten, sonst erkennt Symphony sie nicht).
3. Bug-Sub-Issues anlegen, Label `bug`. Sie beginnen **nicht** mit einem Befehl.
4. Genau einen Report-Kommentar mit `add_comment` posten: Kontext, Baseline, Checkliste `- [ ] #N Titel`, Nicht angelegt, Unklar.
5. `set_status("In review")` aufrufen und den Turn beenden. Es laufen keine Entry-Checks.

Ein Sub-Issue, das `create_sub_issue` mit `limit_reached` ablehnt, gehört in den Report. Unbekannte Labels
(`unknown_labels`) erwähnst du dort ebenfalls. Schreibe Sub-Issues und Report in der Sprache des Epics.
