# Analysis checklist

Determine the version first, then check. Hits without evidence (file:line) are not findings. **B** = bug candidate,
**R** = refactoring candidate.

## Laravel

- **B** N+1 queries: relations in loops, Blade, resources or tables without `with`/`load`; `Model::preventLazyLoading` is off.
- **B** Mass assignment: `$guarded = []`, `forceFill`, `unguard` on user input, `$request->all()` in `create`/`update`.
- **B** Missing authorization: controllers, routes, jobs or actions without policy/gate; routes that change data without `auth` middleware.
- **B** Transactions and queues: several related writes without `DB::transaction`; jobs without `$tries`/`$backoff`, not idempotent, `dispatch` inside a transaction without `afterCommit`.
- **B** Time and numbers: `now()` in migration defaults, time zone comparisons, money as `float`, rounding errors.
- **B** Configuration: `env()` outside `config/`, secrets in code, `APP_DEBUG` hard-wired.
- **R** Fat controllers, models or Livewire components; business logic in Blade; duplicated validation (form requests, rules).
- **R** Deprecated or removed APIs of the installed Laravel version; helpers the framework now provides.
- **R** Dead code: unused routes, methods, models, leftover migrations, config keys (back up with `list-routes` and search).
- **R** Missing indexes on foreign keys and frequently filtered columns (`database-schema`), irreversible migrations.

## Filament

- **B** Resources, pages, relation managers and actions without authorization (`canViewAny`, `canCreate`, `canEdit`, `canDelete`, policies); actions that change data without confirmation or checks.
- **B** Tables and widgets with N+1 (columns via relations without `modifyQueryUsing(... ->with())`), unfiltered `Model::all()` in widgets.
- **B** Multi-tenancy: queries that bypass the tenant scope (`withoutGlobalScopes`, raw queries).
- **B** Forms: missing or too lax validation, file uploads without type and size checks.
- **R** APIs of the wrong or an outdated major version (v3 patterns in v4/v5, removed classes); check against the installed version with `search-docs`.
- **R** Repeated form, table or filter definitions that belong in shared schemas or traits; resources that contain logic instead of actions/services.

## Livewire

- **B** Public properties with sensitive data or models without a lock (`#[Locked]`); actions without authorization.
- **B** `wire:model` behaviour of the installed version misunderstood (deferred by default since v3, different bubbling since v4).
- **R** Large components that can be split into smaller ones; computations that need `#[Computed]`.

## Frontend and build

- **B** `npm run build` fails or warns; Vite entries that do not exist; missing `@vite` inclusion.
- **B** `npm audit` with high/critical on packages that end up in the build.
- **R** Outdated Vite/Tailwind configuration for the installed major version; unused dependencies, duplicate libraries.
- **R** Inline scripts that Alpine or Livewire means could replace.

## Tests

- **R** Areas without tests, tests without meaningful assertions (only status code), skipped or marked tests; factories that do not match the schema.
