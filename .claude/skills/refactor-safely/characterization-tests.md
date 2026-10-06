# Characterization-Tests

Ein Characterization-Test hält fest, **was der Code heute tut**, nicht was er tun sollte. Er ist die Messlatte für das
Refactoring. Gefällt dir das Verhalten nicht, schreibst du es trotzdem so auf und meldest es als Befund.

## Wann schreiben

Der Bereich hat keine Tests, oder sie prüfen zu wenig (nur Statuscode, nur „läuft ohne Fehler“). Prüfe das mit einer
kurzen Mutation im Kopf: Würde ein Test rot, wenn ich die Rückgabe, die Reihenfolge oder eine Bedingung ändere?

## Wie

1. **Verhalten ermitteln**: Code lesen, im Zweifel einmal ausführen (Testlauf, nicht Produktion) und die Ausgabe
   notieren. Nicht raten.
2. **Äußere Schnittstelle testen**, nicht die Innereien, die du gleich umbaust:
   - HTTP/Livewire/Filament: Antwort, gerenderte Ausgabe, Validierungsfehler, Autorisierung (erlaubt und verboten)
   - Services/Actions: Rückgabewert, Datenbankzustand danach, ausgelöste Events/Jobs/Mails (`Event::fake()` usw.)
   - Fehlerfälle: ungültige Eingabe, fehlende Datensätze, fehlende Rechte
3. **Echte Daten statt Mocks** (Factories, `RefreshDatabase`), Mocks nur an der Systemgrenze (HTTP, Mail, Zeit).
4. **Deterministisch**: Zeit mit `Carbon::setTestNow`, Zufall und Reihenfolgen festlegen.
5. **Grün auf dem unveränderten Code**, bevor du etwas umbaust. Ein roter Characterization-Test bedeutet: Du hast das
   Verhalten falsch beschrieben. Korrigiere den Test, nicht den Code.
6. In getrennten Commit(s) vor dem Refactoring. Pest, wenn das Projekt Pest nutzt, sonst PHPUnit; nutze die vorhandenen
   Helfer und Konventionen.

## Grenzen

Charakterisiere, was das Refactoring berührt, nicht das ganze Modul. Ein Test für jede Verzweigung im berührten Code,
nicht für jede Methode im Projekt.
