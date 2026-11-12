import { NgQueryResult } from '@/lib/db/models'

/**
 * Where an import runs its SQL. A transactional session holds one dedicated
 * connection for the whole import so it can be rolled back.
 */
export interface ImportSession {
  readonly transactional: boolean
  readonly savepoints: boolean
  execute(sql: string): Promise<NgQueryResult[]>
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  savepoint(name: string): Promise<void>
  rollbackTo(name: string): Promise<void>
  release(name: string): Promise<void>
  close(): Promise<void>
}

export interface TransactionSql {
  begin: string
  commit: string
  rollback: string
  savepoint?: (name: string) => string
  rollbackTo?: (name: string) => string
  /** omitted where savepoints can't be released (SQL Server) */
  release?: (name: string) => string
}

export const standardTransactionSql: TransactionSql = {
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  savepoint: (name) => `SAVEPOINT ${name}`,
  rollbackTo: (name) => `ROLLBACK TO SAVEPOINT ${name}`,
  release: (name) => `RELEASE SAVEPOINT ${name}`,
}

export interface SqlSessionOptions {
  execute: (sql: string) => Promise<NgQueryResult[]>
  close?: () => Promise<void>
  /** null for a session without transactions */
  transaction: TransactionSql | null
}

/** A session that runs transaction control as plain SQL on one connection. */
export class SqlImportSession implements ImportSession {
  readonly transactional: boolean
  readonly savepoints: boolean

  constructor(private options: SqlSessionOptions) {
    this.transactional = !!options.transaction
    this.savepoints = !!options.transaction?.savepoint
  }

  execute(sql: string) {
    return this.options.execute(sql)
  }

  private async run(sql?: string) {
    if (this.transactional && sql) await this.options.execute(sql)
  }

  begin() { return this.run(this.options.transaction?.begin) }
  commit() { return this.run(this.options.transaction?.commit) }
  rollback() { return this.run(this.options.transaction?.rollback) }
  savepoint(name: string) { return this.run(this.options.transaction?.savepoint?.(name)) }
  rollbackTo(name: string) { return this.run(this.options.transaction?.rollbackTo?.(name)) }
  release(name: string) { return this.run(this.options.transaction?.release?.(name)) }

  async close() {
    await this.options.close?.()
  }
}

/** Runs each statement on its own through the client, with no transaction. */
export function autocommitSession(execute: (sql: string) => Promise<NgQueryResult[]>): ImportSession {
  return new SqlImportSession({ execute, transaction: null })
}
