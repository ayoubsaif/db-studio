## Why

ClickHouse is a common analytics database, but this fork (based on the last fully GPL Beekeeper Studio commit, v4.6.2) has no ClickHouse support, and newer upstream code only offers it through commercially licensed files we can't use. We need our own GPL ClickHouse connection that every user gets, with no license or subscription check.

## What Changes

- Add ClickHouse as a connection type: connect over HTTP(S) with host, port, user, password, default database and optional TLS.
- Browse databases, tables, views, materialized views and columns; view table data with paging, sorting and filters.
- Run SQL in the query editor, including cancelling a running query and streaming large results.
- Show table structure (columns, keys, engine), properties and the `CREATE` script.
- Edit table data where ClickHouse allows it: insert rows, and update or delete rows through ClickHouse mutations, with a warning that these are asynchronous and can't be rolled back.
- ClickHouse is not marked as a paid type, so it never shows an upgrade prompt.
- Port the GPL-licensed ClickHouse SQL builder and dialect from upstream `master` (`src/shared/lib/knex-clickhouse`, `src/shared/lib/dialects/clickhouse.ts`), keeping their copyright headers.

## Capabilities

### New Capabilities
- `clickhouse-connection`: connecting to ClickHouse, browsing its objects, running queries and editing data within ClickHouse's limits.

### Modified Capabilities
<!-- none: openspec/specs/ is empty -->

## Impact

- **New code**: `apps/studio/src/lib/db/clients/clickhouse.ts` (+ cursor), `src/components/connection/ClickHouseForm.vue`, ported `src/shared/lib/knex-clickhouse/` and `src/shared/lib/dialects/clickhouse.ts`.
- **Touched**: `src/lib/db/client.ts`, `src/lib/db/clients/index.ts`, `src/lib/db/types.ts`, `src/common/interfaces/IConnection.ts`, `src/shared/lib/dialects/models.ts`, `src/components/ConnectionInterface.vue`, connection icons, app DB migration for any new saved-connection fields.
- **Dependencies**: `@clickhouse/client` (Apache-2.0, official Node client), plus whatever the ported knex builder imports (`@cleverbrush/async`, `@cleverbrush/deep`) or local replacements.
- **Licensing**: nothing from any `src-commercial` directory is copied or consulted; everything added is GPLv3 or compatible.
- **Tests**: integration tests against a ClickHouse container added to `docker-compose.yml`.
