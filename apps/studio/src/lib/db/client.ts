// Copyright (c) 2015 The SQLECTRON Team, 2020 Beekeeper Studio team
import { ConnectionType, IDbConnectionDatabase } from "./types"
import { MysqlClient } from './clients/mysql';
import { PostgresClient } from './clients/postgresql';
import { SQLServerClient } from './clients/sqlserver';
import { SqliteClient } from './clients/sqlite';
import { MariaDBClient } from './clients/mariadb';
import { TiDBClient } from './clients/tidb';
import { RedshiftClient } from './clients/redshift';
import { CockroachClient } from './clients/cockroach';
import { BigQueryClient } from './clients/bigquery';
import { FirebirdClient } from './clients/firebird';
import { OracleClient } from "./clients/oracle";
import { CassandraClient } from "./clients/cassandra";
import { ClickHouseClient } from "./clients/clickhouse";
import { IDbConnectionServer } from "./backendTypes";

/**
 * libSQL ships a native binary that does not exist for every platform
 * (e.g. Windows ARM64). Load the driver on first use so a missing binary
 * only breaks libSQL connections instead of crashing the whole app at startup.
 */
class LazyLibSQLClient {
  constructor(server: IDbConnectionServer, database: IDbConnectionDatabase) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LibSQLClient } = require("./clients/libsql");
    return new LibSQLClient(server, database);
  }
}

const clients = new Map<ConnectionType, any>([
  ['mysql', MysqlClient],
  ['postgresql', PostgresClient],
  ['sqlserver', SQLServerClient],
  ['sqlite', SqliteClient],
  ['redshift', RedshiftClient],
  ['mariadb', MariaDBClient],
  ['tidb', TiDBClient],
  ['cockroachdb', CockroachClient],
  ['bigquery', BigQueryClient],
  ['firebird', FirebirdClient],
  ['oracle', OracleClient],
  ['cassandra', CassandraClient],
  ['libsql', LazyLibSQLClient],
  ['clickhouse', ClickHouseClient],
], );


class FriendlyErrorClient {
  constructor() {
    throw new Error("Unknown DB type. You need to add a driver -> class mapping in src/lib/db/client.ts")
  }
}

export class ClientError extends Error {
  helpLink = null
  constructor(message: string, helpLink: string) {
    super(message)
    this.helpLink = helpLink
  }
}

export function createConnection(server: IDbConnectionServer, database: IDbConnectionDatabase ) {
  /**
   * Database public API
   */
  const client = clients.get(server.config.client) || FriendlyErrorClient;
  return new client(server, database);
}
