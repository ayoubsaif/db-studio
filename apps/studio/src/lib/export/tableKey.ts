import { TableOrView } from '../db/models'

/**
 * A stable id for a table across schemas, for selection lists.
 * Kept free of Node imports so the renderer can use it.
 */
export function tableKey(table: Pick<TableOrView, 'name' | 'schema'>): string {
  return JSON.stringify([table.schema || null, table.name])
}
