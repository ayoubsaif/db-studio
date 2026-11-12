import { TableFilter, TableOrView } from "../db/models";

export enum ExportStatus {
  Idle = 'idle',
  Exporting = 'exporting',
  Paused = 'paused',
  Aborted = 'aborted',
  Completed = 'completed',
  Error = 'error'
}

export interface ExportOptions {
  chunkSize: number;
  deleteOnAbort: boolean;
}

export interface StartExportOptions {
  table: TableOrView,
  query?: string,
  queryName?: string,
  filters: TableFilter[],
  exporter: 'csv' | 'json' | 'sql' | 'jsonl' | 'xlsx'
  filePath: string
  options: {
    chunkSize: number
    deleteOnAbort: boolean
    includeFilter: boolean
  }
  outputOptions: any
}

/** What the export dialog sends to run a multi-table export. */
export interface MultiExportRequest {
  tables: TableOrView[]
  directory: string
  existing: 'overwrite' | 'skip' | 'number'
  exporter: StartExportOptions['exporter']
  options: StartExportOptions['options']
  outputOptions: any
}

export type MultiExportOutcome = 'exported' | 'failed' | 'skipped' | 'cancelled' | 'not started'

/** One table's line in a multi-table export summary. */
export interface MultiExportTableResult {
  name: string
  outcome: MultiExportOutcome
  rows: number
  filePath?: string
  message?: string
}

export interface ExportProgress {
  totalRecords: number;
  countExported: number;
  secondsElapsed: number;
  secondsRemaining: number;
  status: ExportStatus;
  percentComplete: number;
}
export type ProgressCallback = (p: ExportProgress) => void;
