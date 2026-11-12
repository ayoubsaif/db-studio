## Context

Database clients extend `BasicDatabaseClient` (`src/lib/db/clients/BasicDatabaseClient.ts`, ~46 abstract methods) and are registered in the `clients` map in `src/lib/db/client.ts`. A connection type also has to be listed in `ConnectionTypes` (`src/lib/db/types.ts`), the `ConnectionType` union (`src/common/interfaces/IConnection.ts`), the `CLIENTS` config (`src/lib/db/clients/index.ts`) and the dialect list (`src/shared/lib/dialects/models.ts`), and needs a form in `ConnectionInterface.vue`. The LibSQL commit (`34e099945`) is the best recent example of this path. BigQuery shows the custom knex client pattern (`src/shared/lib/knex-bigquery`) that ClickHouse needs.

Upstream `master` has GPL files for ClickHouse outside `src-commercial`: the knex builder and the dialect. The client class itself is in `src-commercial` and is off-limits.

## Goals / Non-Goals

**Goals:**
- A ClickHouse client that passes the shared integration suite where ClickHouse semantics allow, with the rest explicitly marked unsupported.
- Streaming results through a `BeeCursor`, so query-to-file and export work with no row limit.

**Non-Goals:**
- Native TCP protocol (port 9000); HTTP only.
- Cluster management, `ON CLUSTER` DDL, user and role management, backups.
- Creating or altering tables through the structure editor beyond what the ported builder already supports. Reading structure is in scope; editing structure is best effort.

## Decisions

1. **Driver: `@clickhouse/client` over HTTP.** It is the official, maintained Node client (Apache-2.0), with streaming (`JSONCompactEachRow`) and query cancellation via `AbortController`. Alternative: the older `clickhouse` npm package, which is less maintained and has no proper stream API.
2. **Port GPL pieces from `master`, write the client fresh.** Port `src/shared/lib/knex-clickhouse/**` and `src/shared/lib/dialects/clickhouse.ts` with `git show master:<path>`, keeping copyright headers, and adapting imports to v4.6.2 paths. Write `clickhouse.ts` and `ClickHouseCursor.ts` from our own reading of `BasicDatabaseClient` and the ClickHouse docs. Never open `src-commercial/**` on `master`.
3. **Databases map to "databases", not schemas.** ClickHouse has no schema level. `listSchemas` returns `[]`, `server:schema` is disabled in `CLIENTS`, and the database switcher lists `SHOW DATABASES` minus `system`, `INFORMATION_SCHEMA` and `information_schema` (shown only when the user enables system objects, if that toggle exists).
4. **Metadata from `system.*` tables.** Tables and views from `system.tables` (`engine` tells table vs view vs materialized view), columns from `system.columns` (`is_in_primary_key`, `is_in_sorting_key`, `default_kind`, `comment`), and properties (size, row count) from `system.parts` summed over active parts. The `CREATE` script comes from `SHOW CREATE TABLE`.
5. **Primary key = ClickHouse primary key columns.** `getPrimaryKeys` returns columns with `is_in_primary_key = 1`. These are not unique, so the data grid's row identity can match more than one row. Updates and deletes are therefore built with every primary-key column, and the UI warns that a mutation affects all matching rows.
6. **Edits use mutations.** Insert uses a plain `INSERT`. Update uses `ALTER TABLE ... UPDATE ... WHERE`, and delete uses `DELETE FROM` (lightweight delete, ClickHouse 22.8+), falling back to `ALTER TABLE ... DELETE`. `applyChanges` runs them one after another, with no transaction, and reports which statements ran if one fails. Applying edits is confirmed by the user once per save with a "mutations can't be rolled back" message.
7. **Feature flags.** `supportedFeatures`: `customRoutines: false`, `comments: true`, `properties: true`, `partitions: false`, `editPartitions: false`, `backups: false`, `backDirFormat: false`, `restore: false`, `indexNullsNotDistinct: false`. Routines, triggers and charsets return empty lists. `createDatabase` uses `CREATE DATABASE` and ignores charset and collation.
8. **Not a paid type.** `clickhouse` is added to the community dialect list and not to `isUltimateType` or `ultimateDialects`.

## Risks / Trade-offs

- [The ported knex builder depends on newer code on `master`] → Port only what compiles against v4.6.2. Replace `@cleverbrush/*` helpers with lodash if they pull in more than a few small functions.
- [`@clickhouse/client` needs a newer Node than the Electron version here ships] → Check the package's `engines` field against Electron's Node version before adding it; pin an older client major if needed.
- [Non-unique primary keys make row edits ambiguous] → Use all key columns, warn the user, and show the number of affected rows after the mutation where the server reports it.
- [Mutations are asynchronous, so the grid may show old values right after a save] → Run edits with `mutations_sync = 1` so the call waits for the mutation to finish.

## Migration Plan

Adds a value to the saved-connection `connectionType` column. Add an app DB migration only if new columns are needed (for example a TLS option not covered by existing `ssl` fields). Rollback is reverting the change; saved ClickHouse connections then fail with the existing "Unknown DB type" error rather than corrupting data.
