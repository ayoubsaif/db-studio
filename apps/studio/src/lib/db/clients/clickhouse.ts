import { createClient, ClickHouseClient as Driver, ClickHouseSettings } from '@clickhouse/client';
import { autocommitSession, ImportSession } from '@/lib/import/session';
import https from 'https';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import knexlib from 'knex';
import _ from 'lodash';
import rawLog from 'electron-log';
import { identify } from 'sql-query-identifier';
import { TableKey } from '@shared/lib/dialects/models';
import { ClickHouseData } from '@shared/lib/dialects/clickhouse';
import { ClickhouseKnexClient } from '@shared/lib/knex-clickhouse';
import { ClickHouseChangeBuilder } from '@shared/lib/sql/change_builder/ClickHouseChangeBuilder';
import { ChangeBuilderBase } from '@shared/lib/sql/change_builder/ChangeBuilderBase';
import { createCancelablePromise } from '@/common/utils';
import { errors } from '@/lib/errors';
import {
  CancelableQuery, DatabaseFilterOptions, ExtendedTableColumn, FieldDescriptor, FilterOptions, NgQueryResult, OrderBy,
  PrimaryKeyColumn, Routine, SchemaFilterOptions, StreamResults, SupportedFeatures, TableChanges, TableColumn,
  TableDelete, TableFilter, TableIndex, TableOrView, TableProperties, TableResult, TableTrigger, TableUpdate,
  TableUpdateResult,
} from '../models';
import { DatabaseElement, IDbConnectionDatabase } from '../types';
import { IDbConnectionServer } from '../backendTypes';
import { BasicDatabaseClient } from './BasicDatabaseClient';
import { buildFilterString, buildInsertQuery } from './utils';
import { ClickHouseCursor } from './clickhouse/ClickHouseCursor';

const log = rawLog.scope('clickhouse');
const { wrapIdentifier, escapeString } = ClickHouseData;

export interface ClickHouseResult {
  /** rows as arrays, in `meta` order */
  rows: any[][];
  meta: { name: string, type: string }[];
  command: string;
  /** true for statements that produce a result set (SELECT, SHOW, ...) */
  returnsRows: boolean;
  /** rows the query would have returned without its LIMIT, when the server reports it */
  rowsBeforeLimit?: number;
  affectedRows?: number;
}

interface RunOptions {
  abortSignal?: AbortSignal;
  /** called with each statement's query id before it is sent, so it can be killed */
  onQueryId?: (id: string) => void;
  settings?: ClickHouseSettings;
}

const SYSTEM_DATABASES = ['system', 'INFORMATION_SCHEMA', 'information_schema'];
const VIEW_ENGINES = ['View', 'MaterializedView', 'LiveView', 'WindowView'];

// Statements that produce a result set. Everything else runs as a command,
// because the driver appends `FORMAT ...` to queries and DDL would reject it.
const RETURNS_ROWS = /^\(*\s*(select|with|show|desc|describe|explain|exists|check|values)\b/i;

function stripLeadingComments(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith('--')) {
      const end = s.indexOf('\n');
      s = end === -1 ? '' : s.slice(end + 1).trimStart();
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2).trimStart();
    } else {
      return s;
    }
  }
}

export function splitStatements(sql: string): string[] {
  try {
    const statements = identify(sql, { strict: false, dialect: 'generic' })
      .map((s) => s.text.trim())
      .filter((s) => !!stripLeadingComments(s).replace(/;\s*$/, '').trim());
    if (statements.length) return statements;
  } catch (e) {
    log.debug('could not split statements, sending as one', e);
  }
  return [sql];
}

export function returnsRows(statement: string): boolean {
  return RETURNS_ROWS.test(stripLeadingComments(statement));
}

function commandName(statement: string): string {
  const word = stripLeadingComments(statement).replace(/^\(+/, '').split(/\s+/)[0] || '';
  return word.toUpperCase();
}

function literal(value: string): string {
  return escapeString(value, true) ?? "''";
}

export class ClickHouseClient extends BasicDatabaseClient<ClickHouseResult> {
  connectionBaseType = 'clickhouse' as const;
  client: Driver;

  constructor(server: IDbConnectionServer, database: IDbConnectionDatabase) {
    super(null, null, server, database);
    // sql-query-identifier has no ClickHouse dialect; generic splits on `;`
    this.dialect = 'generic';
    this.contextProvider = {
      getExecutionContext: () => null,
      logQuery: () => null,
    };
  }

  // Connection ***************************************************************

  get databaseName(): string {
    return this.db || this.server.config.options?.database || 'default';
  }

  private url(): string {
    const config = this.server.config;
    const host = config.localHost || config.host || 'localhost';
    const port = config.localPort || config.port || (config.ssl ? 8443 : 8123);
    return `${config.ssl ? 'https' : 'http'}://${host}:${port}`;
  }

  private httpsAgent(): https.Agent | undefined {
    const config = this.server.config;
    if (!config.ssl) return undefined;
    const ca = config.sslCaFile ? readFileSync(config.sslCaFile) : undefined;
    const cert = config.sslCertFile ? readFileSync(config.sslCertFile) : undefined;
    const key = config.sslKeyFile ? readFileSync(config.sslKeyFile) : undefined;
    return new https.Agent({
      keepAlive: true,
      ca, cert, key,
      // as with MySQL and the form's hint: without certificate files the
      // server certificate is trusted; with them, follow the user's setting
      rejectUnauthorized: (ca || cert || key) ? config.sslRejectUnauthorized : false,
    });
  }

  async connect(): Promise<void> {
    await super.connect();
    const config = this.server.config;
    this.client = createClient({
      url: this.url(),
      username: config.user || 'default',
      password: config.password || '',
      database: this.databaseName,
      application: 'Beekeeper Studio',
      http_agent: this.httpsAgent(),
      clickhouse_settings: {
        // the server stops sending results once a request's connection closes
        cancel_http_readonly_queries_on_client_close: 1,
        // JavaScript numbers can't hold every 64-bit integer or decimal exactly,
        // so have the server send them as strings
        output_format_json_quote_64bit_integers: 1,
        output_format_json_quote_decimals: 1,
      },
    });
    // used only to build SQL text; it never opens its own connection
    this.knex = knexlib({ client: ClickhouseKnexClient as any });

    // fail now, with the server's message, rather than on the first query
    const ping = await this.client.ping();
    if (!ping.success) {
      await this.client.close();
      throw ping.error;
    }
    await this.versionString();
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    await super.disconnect();
  }

  // Metadata *****************************************************************

  async supportedFeatures(): Promise<SupportedFeatures> {
    return {
      customRoutines: false,
      comments: true,
      properties: true,
      partitions: false,
      editPartitions: false,
      backups: false,
      backDirFormat: false,
      restore: false,
      indexNullsNotDistinct: false,
    };
  }

  private version: string;
  async versionString(): Promise<string> {
    if (!this.version) {
      this.version = (await this.selectValue('SELECT version()')) as string;
    }
    return this.version;
  }

  getBuilder(table: string, _schema?: string): ChangeBuilderBase {
    // column details are only needed for nullable changes, which the structure
    // editor fetches separately; an empty list keeps this synchronous
    return new ClickHouseChangeBuilder(table, null, []);
  }

  wrapIdentifier(value: string): string {
    return wrapIdentifier(value);
  }

  private qualified(table: string): string {
    return `${wrapIdentifier(this.databaseName)}.${wrapIdentifier(table)}`;
  }

  // Listing ******************************************************************

  async listDatabases(filter?: DatabaseFilterOptions): Promise<string[]> {
    const rows = await this.selectObjects(
      `SELECT name FROM system.databases WHERE name NOT IN (${SYSTEM_DATABASES.map(literal).join(', ')}) ORDER BY name`
    );
    let names = rows.map((r) => r.name as string);
    if (filter?.only?.length) names = names.filter((n) => filter.only.includes(n));
    if (filter?.ignore?.length) names = names.filter((n) => !filter.ignore.includes(n));
    return names;
  }

  async listSchemas(_filter?: SchemaFilterOptions): Promise<string[]> {
    return [];
  }

  private async listByEngine(condition: string, entityType: TableOrView['entityType']): Promise<TableOrView[]> {
    const rows = await this.selectObjects(`
      SELECT name, engine
      FROM system.tables
      WHERE database = ${literal(this.databaseName)}
        AND NOT is_temporary
        AND NOT startsWith(name, '.inner')
        AND ${condition}
      ORDER BY name
    `);
    return rows.map((r) => ({ name: r.name, entityType, tabletype: r.engine }));
  }

  async listTables(_filter?: FilterOptions): Promise<TableOrView[]> {
    return this.listByEngine(`engine NOT IN (${VIEW_ENGINES.map(literal).join(', ')})`, 'table');
  }

  async listViews(_filter?: FilterOptions): Promise<TableOrView[]> {
    return this.listByEngine(`engine = 'View'`, 'view');
  }

  async listMaterializedViews(_filter?: FilterOptions): Promise<TableOrView[]> {
    return this.listByEngine(`engine = 'MaterializedView'`, 'materialized-view');
  }

  async listRoutines(_filter?: FilterOptions): Promise<Routine[]> {
    return [];
  }

  async listTableColumns(table?: string, _schema?: string): Promise<ExtendedTableColumn[]> {
    const rows = await this.selectObjects(`
      SELECT table, name, type, position, default_kind, default_expression, comment, is_in_primary_key
      FROM system.columns
      WHERE database = ${literal(this.databaseName)}
        ${table ? `AND table = ${literal(table)}` : ''}
      ORDER BY table, position
    `);
    return rows.map((r) => ({
      tableName: r.table,
      columnName: r.name,
      dataType: r.type,
      ordinalPosition: Number(r.position),
      nullable: /^(LowCardinality\()?Nullable\(/.test(r.type),
      hasDefault: !!r.default_kind,
      defaultValue: r.default_kind === 'DEFAULT' ? r.default_expression : null,
      generated: ['MATERIALIZED', 'ALIAS'].includes(r.default_kind),
      comment: r.comment || null,
      primaryKey: Number(r.is_in_primary_key) === 1,
    }));
  }

  async listMaterializedViewColumns(table: string, schema?: string): Promise<TableColumn[]> {
    return this.listTableColumns(table, schema);
  }

  async listTableTriggers(_table: string, _schema?: string): Promise<TableTrigger[]> {
    return [];
  }

  async listTableIndexes(_table: string, _schema?: string): Promise<TableIndex[]> {
    return [];
  }

  async getTableReferences(_table: string, _schema?: string): Promise<string[]> {
    return [];
  }

  async getTableKeys(_table: string, _schema?: string): Promise<TableKey[]> {
    return [];
  }

  /**
   * ClickHouse primary keys are not unique: they only order the data on disk.
   * Edits use every key column, and the UI warns that all matching rows change.
   */
  async getPrimaryKeys(table: string, _schema?: string): Promise<PrimaryKeyColumn[]> {
    const rows = await this.selectObjects(`
      SELECT name
      FROM system.columns
      WHERE database = ${literal(this.databaseName)} AND table = ${literal(table)} AND is_in_primary_key
      ORDER BY position
    `);
    const columns = rows.map((r) => r.name as string);
    const expression = (await this.selectValue(
      `SELECT primary_key FROM system.tables WHERE database = ${literal(this.databaseName)} AND name = ${literal(table)}`
    )) as string || '';
    // keep the order of the key expression where it names plain columns
    const ordered = expression.split(',').map((s) => ClickHouseData.unwrapIdentifier(s.trim()))
      .filter((name) => columns.includes(name));
    const keys = _.uniq([...ordered, ...columns]);
    return keys.map((columnName, i) => ({ columnName, position: i + 1 }));
  }

  async getPrimaryKey(table: string, schema?: string): Promise<string | null> {
    const keys = await this.getPrimaryKeys(table, schema);
    return keys.length === 1 ? keys[0].columnName : null;
  }

  async getTableLength(table: string, _schema?: string): Promise<number> {
    return Number(await this.selectValue(`SELECT count() FROM ${this.qualified(table)}`));
  }

  async getTableProperties(table: string, schema?: string): Promise<TableProperties | null> {
    const [row] = await this.selectObjects(`
      SELECT comment, total_bytes, engine
      FROM system.tables
      WHERE database = ${literal(this.databaseName)} AND name = ${literal(table)}
    `);
    if (!row) return null;
    const isView = VIEW_ENGINES.includes(row.engine);
    return {
      description: row.comment || null,
      size: Number(row.total_bytes) || 0,
      length: isView ? undefined : await this.getTableLength(table, schema),
      indexes: [],
      relations: [],
      triggers: [],
    } as TableProperties;
  }

  async getQuerySelectTop(table: string, limit: number, _schema?: string): Promise<string> {
    return `SELECT * FROM ${wrapIdentifier(table)} LIMIT ${limit}`;
  }

  // Create scripts ***********************************************************

  private async showCreate(name: string): Promise<string> {
    return (await this.selectValue(`SHOW CREATE TABLE ${this.qualified(name)}`)) as string;
  }

  async getTableCreateScript(table: string, _schema?: string): Promise<string> {
    return this.showCreate(table);
  }

  async getViewCreateScript(view: string, _schema?: string): Promise<string[]> {
    return [await this.showCreate(view)];
  }

  async getMaterializedViewCreateScript(view: string, _schema?: string): Promise<string[]> {
    return [await this.showCreate(view)];
  }

  async getRoutineCreateScript(_routine: string, _type: string, _schema?: string): Promise<string[]> {
    return [];
  }

  async listCharsets(): Promise<string[]> {
    return [];
  }

  async getDefaultCharset(): Promise<string> {
    return null;
  }

  async listCollations(_charset: string): Promise<string[]> {
    return [];
  }

  async createDatabase(databaseName: string, _charset: string, _collation: string): Promise<void> {
    await this.command(`CREATE DATABASE ${wrapIdentifier(databaseName)}`);
  }

  async createDatabaseSQL(): Promise<string> {
    return 'CREATE DATABASE "mydatabase"';
  }

  // Structure changes ********************************************************

  async setTableDescription(table: string, description: string, schema?: string): Promise<string> {
    await this.command(`ALTER TABLE ${this.qualified(table)} MODIFY COMMENT ${literal(description || '')}`);
    return (await this.getTableProperties(table, schema))?.description;
  }

  async setElementNameSql(elementName: string, newElementName: string, typeOfElement: DatabaseElement, _schema?: string): Promise<string> {
    switch (typeOfElement) {
      case DatabaseElement.TABLE:
      case DatabaseElement.VIEW:
      case DatabaseElement['MATERIALIZED-VIEW']:
        return `RENAME TABLE ${this.qualified(elementName)} TO ${this.qualified(newElementName)}`;
      case DatabaseElement.DATABASE:
        return `RENAME DATABASE ${wrapIdentifier(elementName)} TO ${wrapIdentifier(newElementName)}`;
      default:
        return '';
    }
  }

  async dropElement(elementName: string, typeOfElement: DatabaseElement, _schema?: string): Promise<void> {
    switch (typeOfElement) {
      case DatabaseElement.DATABASE:
        await this.command(`DROP DATABASE ${wrapIdentifier(elementName)}`);
        return;
      case DatabaseElement.VIEW:
      case DatabaseElement['MATERIALIZED-VIEW']:
        await this.command(`DROP VIEW ${this.qualified(elementName)}`);
        return;
      case DatabaseElement.TABLE:
        await this.command(`DROP TABLE ${this.qualified(elementName)}`);
        return;
      default:
        throw new Error(`ClickHouse can't drop a ${typeOfElement}`);
    }
  }

  async truncateElementSql(elementName: string, typeOfElement: DatabaseElement, _schema?: string): Promise<string> {
    return typeOfElement === DatabaseElement.TABLE ? `TRUNCATE TABLE ${this.qualified(elementName)}` : '';
  }

  async truncateAllTables(_schema?: string): Promise<void> {
    for (const table of await this.listTables()) {
      await this.command(`TRUNCATE TABLE ${this.qualified(table.name)}`);
    }
  }

  async duplicateTableSql(tableName: string, duplicateTableName: string, _schema?: string): Promise<string> {
    return [
      `CREATE TABLE ${this.qualified(duplicateTableName)} AS ${this.qualified(tableName)}`,
      `INSERT INTO ${this.qualified(duplicateTableName)} SELECT * FROM ${this.qualified(tableName)}`,
    ].join(';\n') + ';';
  }

  async duplicateTable(tableName: string, duplicateTableName: string, schema?: string): Promise<void> {
    for (const statement of splitStatements(await this.duplicateTableSql(tableName, duplicateTableName, schema))) {
      await this.command(statement);
    }
  }

  // Table data ***************************************************************

  private selectTopParts(table: string, orderBy: OrderBy[], filters: string | TableFilter[], columns: TableColumn[], selects?: string[]) {
    let where = '';
    if (_.isString(filters)) {
      where = filters.trim() ? `WHERE ${filters}` : '';
    } else {
      const { filterString, filterParams } = buildFilterString(filters, columns);
      // fill the `?` placeholders with escaped values, as ClickHouse's HTTP
      // interface has no positional parameters
      where = filterString ? this.knex.raw(filterString, filterParams).toQuery() : '';
    }
    const order = orderBy?.length
      ? `ORDER BY ${orderBy.map((o) => `${wrapIdentifier(o.field)} ${o.dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}`
      : '';
    const select = selects?.length && !_.isEqual(selects, ['*']) ? selects.map(wrapIdentifier).join(', ') : '*';
    return { from: `FROM ${this.qualified(table)} ${where}`, order, select };
  }

  async selectTopSql(table: string, offset: number, limit: number, orderBy: OrderBy[], filters: string | TableFilter[], schema?: string, selects?: string[]): Promise<string> {
    const columns = await this.listTableColumns(table, schema);
    const { from, order, select } = this.selectTopParts(table, orderBy, filters, columns, selects);
    return [
      `SELECT ${select} ${from}`,
      order,
      _.isNumber(limit) ? `LIMIT ${limit}` : '',
      _.isNumber(offset) ? `OFFSET ${offset}` : '',
    ].filter(Boolean).join(' ');
  }

  async selectTop(table: string, offset: number, limit: number, orderBy: OrderBy[], filters: string | TableFilter[], schema?: string, selects?: string[]): Promise<TableResult> {
    const sql = await this.selectTopSql(table, offset, limit, orderBy, filters, schema, selects);
    const [result] = await this.run(sql);
    return {
      result: this.toObjects(result),
      fields: result.meta.map((m) => m.name),
    };
  }

  async selectTopStream(table: string, orderBy: OrderBy[], filters: string | TableFilter[], chunkSize: number, schema?: string): Promise<StreamResults> {
    const columns = await this.listTableColumns(table, schema);
    const { from, order } = this.selectTopParts(table, orderBy, filters, columns);
    const totalRows = Number(await this.selectValue(`SELECT count() ${from}`));
    return {
      totalRows,
      columns,
      cursor: new ClickHouseCursor(this.client, `SELECT * ${from} ${order}`, chunkSize),
    };
  }

  async queryStream(query: string, chunkSize: number): Promise<StreamResults> {
    const statement = splitStatements(query)[0].replace(/;\s*$/, '');
    let columns: TableColumn[];
    let totalRows: number;
    try {
      // a SELECT can be described and counted as a subquery
      const described = await this.selectObjects(`DESCRIBE (${statement})`);
      columns = described.map((d) => ({ columnName: d.name, dataType: d.type }));
      totalRows = Number(await this.selectValue(`SELECT count() FROM (${statement})`));
    } catch (e) {
      // SHOW and friends can't be; stop after one row just to learn the columns
      log.debug('falling back to a one-row run for columns', e.message);
      const [result] = await this.run(statement, { settings: { max_result_rows: '1', result_overflow_mode: 'break' } });
      columns = result.meta.map((m) => ({ columnName: m.name, dataType: m.type }));
      totalRows = undefined;
    }
    return {
      totalRows,
      columns,
      cursor: new ClickHouseCursor(this.client, statement, chunkSize),
    };
  }

  // Edits ********************************************************************

  private updateSql(updates: TableUpdate[]): string[] {
    return updates.map((update) => {
      const where = Object.fromEntries(update.primaryKeys.map(({ column, value }) => [column, value]));
      return this.knex(update.table).where(where).update({ [update.column]: update.value }).toQuery();
    });
  }

  private deleteSql(deletes: TableDelete[]): string[] {
    return deletes.map((del) => {
      const where = Object.fromEntries(del.primaryKeys.map(({ column, value }) => [column, value]));
      return this.knex(del.table).where(where).delete().toQuery();
    });
  }

  async applyChangesSql(changes: TableChanges): Promise<string> {
    const statements = [
      ...(changes.inserts || []).map((insert) => buildInsertQuery(this.knex, insert)),
      ...this.updateSql(changes.updates || []),
      ...this.deleteSql(changes.deletes || []),
    ];
    return statements.length ? statements.join(';\n') + ';' : '';
  }

  /**
   * ClickHouse has no transactions, so changes run one at a time and each one
   * waits for its mutation to finish. If one fails, the error says how many
   * earlier changes were already applied, since those can't be undone.
   */
  async applyChanges(changes: TableChanges): Promise<TableUpdateResult[]> {
    const steps: { sql: string, isDelete?: boolean }[] = [];
    for (const insert of changes.inserts || []) {
      const columns = await this.listTableColumns(insert.table, insert.schema);
      steps.push({ sql: buildInsertQuery(this.knex, insert, columns) });
    }
    this.updateSql(changes.updates || []).forEach((sql) => steps.push({ sql }));
    this.deleteSql(changes.deletes || []).forEach((sql) => steps.push({ sql, isDelete: true }));

    const settings: ClickHouseSettings = { mutations_sync: '1' };
    for (const [i, step] of steps.entries()) {
      try {
        try {
          await this.command(step.sql, settings);
        } catch (err) {
          // lightweight DELETE needs ClickHouse 22.8+; fall back to a mutation
          if (step.isDelete && /lightweight|DELETE.*not supported|UNSUPPORTED_METHOD/i.test(err.message)) {
            await this.command(step.sql.replace(/^delete from (.+?) where /i, 'ALTER TABLE $1 DELETE WHERE '), settings);
          } else {
            throw err;
          }
        }
      } catch (err) {
        const applied = i === 0
          ? 'No changes were applied.'
          : `The first ${i} of ${steps.length} changes were already applied and can't be rolled back.`;
        throw new Error(`Change ${i + 1} of ${steps.length} failed: ${err.message} ${applied}`);
      }
    }

    // return the saved rows so the grid shows what the server stored
    const results = [];
    for (const update of changes.updates || []) {
      const where = Object.fromEntries(update.primaryKeys.map(({ column, value }) => [column, value]));
      const [result] = await this.run(this.knex(update.table).where(where).select('*').limit(1).toQuery());
      results.push(...this.toObjects(result));
    }
    return results;
  }

  // Queries ******************************************************************

  async query(queryText: string, _options?: any): Promise<CancelableQuery> {
    const abort = new AbortController();
    let queryId: string = null;
    const cancelable = createCancelablePromise({
      ...errors.CANCELED_BY_USER,
      // eslint-disable-next-line
      // @ts-ignore
      sqlectronError: 'CANCELED_BY_USER',
    });

    return {
      execute: async () => {
        try {
          return await Promise.race([
            cancelable.wait(),
            this.executeQuery(queryText, { abortSignal: abort.signal, onQueryId: (id) => { queryId = id } }),
          ]);
        } catch (err) {
          // aborting the request rejects at once; report it as a user cancel
          if (abort.signal.aborted) {
            throw Object.assign(new Error(errors.CANCELED_BY_USER.message), {
              ...errors.CANCELED_BY_USER,
              sqlectronError: 'CANCELED_BY_USER',
            });
          }
          throw err;
        } finally {
          cancelable.discard();
        }
      },
      cancel: async () => {
        abort.abort();
        if (queryId) {
          // closing the connection only stops read-only queries; kill it outright
          await this.client.command({
            query: `KILL QUERY WHERE query_id = ${literal(queryId)} ASYNC`,
          }).catch((e) => log.warn('kill query failed', e));
        }
        cancelable.cancel();
      },
    };
  }

  async createImportSession(_useTransaction: boolean): Promise<ImportSession> {
    // no transactions; wait for each mutation so later batches see its result
    return autocommitSession((sql) => this.executeQuery(sql, { settings: { mutations_sync: '1' } }))
  }

  async executeQuery(queryText: string, options: RunOptions = {}): Promise<NgQueryResult[]> {
    const results = await this.run(queryText, options);
    return results.map((result) => {
      const fields: FieldDescriptor[] = result.meta.map((m, i) => ({ id: `c${i}`, name: m.name, dataType: m.type }));
      const ids = fields.map((f) => f.id);
      return {
        command: result.command,
        fields,
        rows: result.rows.map((row) => _.zipObject(ids, row)),
        rowCount: result.returnsRows ? result.rows.length : undefined,
        affectedRows: result.affectedRows,
      };
    });
  }

  private async run(sql: string, options: RunOptions = {}): Promise<ClickHouseResult[]> {
    return this.driverExecuteMultiple(sql, options);
  }

  protected async rawExecuteQuery(q: string, options: RunOptions & { multiple?: boolean }): Promise<ClickHouseResult | ClickHouseResult[]> {
    const results: ClickHouseResult[] = [];
    for (const statement of splitStatements(q)) {
      results.push(await this.runStatement(statement, options));
    }
    return options.multiple ? results : results[0];
  }

  private async runStatement(statement: string, options: RunOptions): Promise<ClickHouseResult> {
    const query = statement.replace(/;\s*$/, '');
    const query_id = randomUUID();
    options.onQueryId?.(query_id);
    const params = {
      query,
      query_id,
      abort_signal: options.abortSignal,
      clickhouse_settings: options.settings,
    };
    log.debug('running', query);

    if (!returnsRows(query)) {
      const result = await this.client.command(params);
      return {
        rows: [],
        meta: [],
        command: commandName(query),
        returnsRows: false,
        affectedRows: Number(result.summary?.written_rows) || undefined,
      };
    }

    const resultSet = await this.client.query({ ...params, format: 'JSONCompact' });
    const json = await resultSet.json<any[]>() as any;
    return {
      rows: json.data || [],
      meta: json.meta || [],
      command: commandName(query),
      returnsRows: true,
      rowsBeforeLimit: json.rows_before_limit_at_least,
    };
  }

  private async command(sql: string, settings?: ClickHouseSettings): Promise<void> {
    await this.driverExecuteSingle(sql, { settings });
  }

  private toObjects(result: ClickHouseResult): Record<string, any>[] {
    const names = result.meta.map((m) => m.name);
    return result.rows.map((row) => _.zipObject(names, row));
  }

  private async selectObjects(sql: string): Promise<Record<string, any>[]> {
    const [result] = await this.run(sql);
    return this.toObjects(result);
  }

  private async selectValue(sql: string): Promise<unknown> {
    const [result] = await this.run(sql);
    return result.rows[0]?.[0];
  }
}
