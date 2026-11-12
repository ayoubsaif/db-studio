## 1. Setup

- [x] 1.1 Install dependencies on the `gpl-community` branch (`yarn install` at repo root) and verify `yarn workspace beekeeper-studio test:unit` runs before any changes
- [x] 1.2 Check `@clickhouse/client`'s `engines.node` against the bundled Electron Node version, add the compatible version to `apps/studio/package.json`, and verify it imports from the main process
- [ ] 1.3 Add a `clickhouse` service (official image, ports 8123/8443) to `docker-compose.yml` and verify `curl http://localhost:8123/ping` returns `Ok.`

## 2. Port GPL pieces from master

- [x] 2.1 Port `src/shared/lib/knex-clickhouse/**` from `master` with `git show`, keep copyright headers, fix imports for v4.6.2, and verify `tsc --noEmit` passes for those files
- [x] 2.2 Port `src/shared/lib/dialects/clickhouse.ts`, register `clickhouse` as a community dialect in `dialects/models.ts` (title "ClickHouse", not in `ultimateDialects`), and verify the dialect unit tests pass
- [x] 2.3 Add a unit test that builds `SELECT`, `INSERT`, `ALTER TABLE ... UPDATE` and `DELETE` with the ported builder and checks identifier quoting

## 3. Client

- [x] 3.1 Add `clickhouse` to `ConnectionType`, `ConnectionTypes`, and `CLIENTS` (default port 8123, `server:schema`, `server:domain` and socket features disabled); verify ClickHouse appears in the connection type picker
- [x] 3.2 Create `ClickHouseClient` extending `BasicDatabaseClient` with connect/disconnect, `versionString`, `listDatabases`, `listTables`, `listViews`, `listMaterializedViews`, `listTableColumns` from `system.*`; verify with an integration test against the docker container
- [x] 3.3 Implement `rawExecuteQuery`, `executeQuery` and cancelable `query` (AbortController); verify multi-statement results and cancellation in integration tests
- [x] 3.4 Implement `ClickHouseCursor` (`JSONCompactEachRow` stream) and `selectTopStream` / `queryStream`; verify streaming 100k rows in chunks in an integration test
- [x] 3.5 Implement `selectTop`/`selectTopSql` with filters and ordering, `getTableLength`, `getTableProperties`, `getPrimaryKey(s)`, `getTableCreateScript`, `getViewCreateScript`; verify with integration tests
- [x] 3.6 Implement `applyChanges`/`applyChangesSql` with insert, mutation update and lightweight delete (`mutations_sync = 1`), reporting which changes ran on failure; verify insert/update/delete and partial-failure tests
- [ ] 3.7 Implement the remaining abstract methods as supported operations (create/drop database and table, truncate, duplicate table, rename) or explicit empty/unsupported results, and set `supportedFeatures` per design; verify the shared client suite in `tests/integration/lib/db/clients/all.js` passes or skips with stated reasons
- [x] 3.8 Register `ClickHouseClient` in `src/lib/db/client.ts` and verify `createConnection` returns it for `clickhouse`

## 4. UI

- [x] 4.1 Create `ClickHouseForm.vue` (host, port, user, password, database, TLS toggle that switches default port 8123/8443) and wire it into `ConnectionInterface.vue`; verify connect and Test in the running app
- [x] 4.2 Add ClickHouse icon and labels in connection list and buttons (`ConnectionListItem.vue`, `ConnectionButton.vue`); verify they render
- [x] 4.3 Add the mutation warning confirmation before saving updates/deletes on ClickHouse tables; verify it shows only for ClickHouse and that cancelling keeps pending edits
- [x] 4.4 Hide charset/collation in create-database and other unsupported actions for ClickHouse; verify no error appears from the sidebar context menus
- [x] 4.5 Add an app DB migration only if new saved-connection fields were needed, and verify a saved ClickHouse connection survives an app restart

## 5. Verification

- [ ] 5.1 Manually test with no license key: create, save, reopen, browse, query, edit and export a ClickHouse table, and confirm no upgrade prompt or paid badge appears anywhere
- [ ] 5.2 Run `yarn workspace beekeeper-studio lint` and the unit and ClickHouse integration tests, and confirm they pass
- [x] 5.3 Confirm with `git diff --stat` that no file under any `src-commercial` path was added or used
