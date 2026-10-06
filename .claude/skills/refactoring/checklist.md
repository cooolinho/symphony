# Analyse-Checkliste

Version zuerst feststellen, dann prüfen. Treffer ohne Beleg (Datei:Zeile) sind keine Befunde. **B** = Bug-Kandidat,
**R** = Refactoring-Kandidat.

## Laravel

- **B** N+1-Abfragen: Relationen in Schleifen, Blade, Resources oder Tabellen ohne `with`/`load`; `Model::preventLazyLoading` ist aus.
- **B** Mass Assignment: `$guarded = []`, `forceFill`, `unguard` auf Benutzereingaben, `$request->all()` in `create`/`update`.
- **B** Fehlende Autorisierung: Controller, Routen, Jobs oder Aktionen ohne Policy/Gate; Routen ohne `auth`-Middleware, die Daten ändern.
- **B** Transaktionen und Queues: mehrere zusammengehörige Schreibvorgänge ohne `DB::transaction`; Jobs ohne `$tries`/`$backoff`, nicht idempotent, `dispatch` innerhalb einer Transaktion ohne `afterCommit`.
- **B** Zeit und Zahlen: `now()` in Defaults von Migrationen, Zeitzonen-Vergleiche, Geld als `float`, Rundungsfehler.
- **B** Konfiguration: `env()` außerhalb von `config/`, Secrets im Code, `APP_DEBUG` fest verdrahtet.
- **R** Dicke Controller, Models oder Livewire-Komponenten; Geschäftslogik in Blade; duplizierte Validierung (Form Requests, Rules).
- **R** Veraltete oder entfernte APIs der installierten Laravel-Version; Hilfsfunktionen, die das Framework inzwischen bietet.
- **R** Toter Code: ungenutzte Routen, Methoden, Models, Migrationen-Reste, Konfigurationsschlüssel (per `list-routes` und Suche belegen).
- **R** Fehlende Indizes auf Fremdschlüsseln und häufig gefilterten Spalten (`database-schema`), nicht umkehrbare Migrationen.

## Filament

- **B** Resources, Pages, Relation Manager und Actions ohne Autorisierung (`canViewAny`, `canCreate`, `canEdit`, `canDelete`, Policies); Aktionen, die Daten ändern, ohne Bestätigung oder Prüfung.
- **B** Tabellen und Widgets mit N+1 (Spalten über Relationen ohne `modifyQueryUsing(... ->with())`), ungefilterte `Model::all()` in Widgets.
- **B** Mandantenfähigkeit: Abfragen, die den Tenant-Scope umgehen (`withoutGlobalScopes`, rohe Queries).
- **B** Formulare: fehlende oder zu lockere Validierung, Dateiuploads ohne Typ- und Größenprüfung.
- **R** APIs der falschen oder veralteten Major-Version (v3-Muster in v4/v5, entfernte Klassen); mit `search-docs` gegen die installierte Version prüfen.
- **R** Wiederholte Formular-, Tabellen- oder Filter-Definitionen, die in gemeinsame Schemas oder Traits gehören; Resources, die Logik statt Actions/Services enthalten.

## Livewire

- **B** Öffentliche Eigenschaften mit sensiblen Daten oder Models ohne Sperre (`#[Locked]`); Aktionen ohne Autorisierung.
- **B** `wire:model`-Verhalten der installierten Version missverstanden (Standard ist ab v3 deferred, ab v4 gilt anderes Bubbling).
- **R** Große Komponenten, die sich in kleinere teilen lassen; Berechnungen, die `#[Computed]` brauchen.

## Frontend und Build

- **B** `npm run build` schlägt fehl oder warnt; Vite-Eingänge, die nicht existieren; fehlende `@vite`-Einbindung.
- **B** `npm audit` mit hoch/kritisch auf Pakete, die in den Build gelangen.
- **R** Veraltete Vite-/Tailwind-Konfiguration für die installierte Major-Version; ungenutzte Abhängigkeiten, doppelte Bibliotheken.
- **R** Inline-Skripte, die Alpine- oder Livewire-Mittel ersetzen könnten.

## Tests

- **R** Bereiche ohne Tests, Tests ohne Aussagekraft (nur Statuscode), übersprungene oder markierte Tests; Factories, die nicht zum Schema passen.
