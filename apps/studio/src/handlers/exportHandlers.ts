import { TableFilter, TableOrView } from "@/lib/db/models";
import { CsvExporter, Export, JsonExporter, JsonLineExporter, SqlExporter, XlsxExporter } from "@/lib/export";
import { ExportStatus } from "@/lib/export/models";
import { ExistingFileMode, exportFileName, resolveTargetPath } from "@/lib/export/multi";
import { uuidv4 } from "@/lib/uuid";
import { checkConnection, errorMessages, state } from "./handlerState";
import rawLog from 'electron-log';
import fs from 'fs';

const log = rawLog.scope('ExportHandler');

export interface ResolveTargetOptions {
  directory: string,
  table: Pick<TableOrView, 'name' | 'schema'>,
  extension: string,
  existing: ExistingFileMode,
  /** paths already used earlier in the same multi-table export */
  taken: string[]
}

export interface ExportResult {
  status: ExportStatus,
  countExported: number,
  error: string | null,
  warnings: string[]
}

interface StartExportOptions {
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

const ExportClassPicker = {
  'csv': CsvExporter,
  'json': JsonExporter,
  'sql': SqlExporter,
  'jsonl': JsonLineExporter,
  'xlsx': XlsxExporter
}

function getExporter(id: string, sId: string): Export {
  const exporter = state(sId).exports.get(id);

  if (!exporter) {
    throw new Error(errorMessages.noExport);
  }

  return exporter;
}

export interface IExportHandlers {
  'export/add': ({ options, sId }: { options: StartExportOptions, sId: string }) => Promise<string>,
  'export/remove': ({ id, sId }: { id: string, sId: string }) => Promise<void>,
  'export/removeInactive': ({ sId }: { sId: string }) => Promise<string[]>,
  'export/status': ({ id, sId }: { id: string, sId: string }) => Promise<ExportStatus>,
  'export/error': ({ id, sId }: { id: string, sId: string }) => Promise<Error>,
  'export/warnings': ({ id, sId }: { id: string, sId: string }) => Promise<string[]>,
  'export/result': ({ id, sId }: { id: string, sId: string }) => Promise<ExportResult>,
  'export/resolveTarget': ({ options }: { options: ResolveTargetOptions, sId: string }) => Promise<string | null>,
  'export/name': ({ id, sId }: { id: string, sId: string }) => Promise<string>,
  'export/start': ({ id, sId }: { id: string, sId: string }) => Promise<void>,
  'export/cancel': ({ id, sId }: { id: string, sId: string }) => Promise<void>
}

export const ExportHandlers: IExportHandlers = {
  'export/add': async function({ options, sId }: { options: StartExportOptions, sId: string }) {
    checkConnection(sId);
    const exporter = new ExportClassPicker[options.exporter](
      options.filePath,
      state(sId).connection,
      options.table,
      options.query,
      options.queryName,
      options.filters || [],
      options.options,
      options.outputOptions
    );
    // maybe just use the id from the export??
    const id = uuidv4();
    state(sId).exports.set(id, exporter);

    return id;
  },

  'export/remove': async function({ id, sId }: { id: string, sId: string }) {
    state(sId).exports.delete(id);
  },

  'export/removeInactive': async function({ sId }: { sId: string}) {
    state(sId).exports = new Map([...state(sId).exports.entries()].filter(([_key, exp]) => exp.status === ExportStatus.Exporting));
    return [...state(sId).exports.keys()];
  },

  'export/status': async function({ id, sId }: { id: string, sId: string }) {
    const exporter = getExporter(id, sId);
    return exporter.status;
  },

  'export/error': async function({ id, sId }: { id: string, sId: string }) {
    const exporter = getExporter(id, sId);
    return exporter.error;
  },

  'export/warnings': async function({ id, sId }: { id: string, sId: string }) {
    const exporter = getExporter(id, sId);
    return exporter.warnings();
  },

  'export/result': async function({ id, sId }: { id: string, sId: string }) {
    const exporter = getExporter(id, sId);
    return {
      status: exporter.status,
      countExported: exporter.countExported,
      error: exporter.error ? exporter.error.message || String(exporter.error) : null,
      warnings: exporter.warnings(),
    };
  },

  'export/resolveTarget': async function({ options }: { options: ResolveTargetOptions, sId: string }) {
    const fileName = exportFileName(options.table, options.extension);
    return resolveTargetPath(
      options.directory,
      fileName,
      options.existing,
      (filePath) => fs.existsSync(filePath),
      new Set((options.taken || []).map((p) => p.toLowerCase()))
    );
  },

  'export/name': async function({ id, sId }: { id: string, sId: string }) {
    const exporter = getExporter(id, sId);

    return exporter.table ? exporter.table.name : exporter.queryName;
  },

  'export/start': async function({ id, sId }: { id: string, sId: string }) {
    const exporter = getExporter(id, sId);

    exporter.onProgress((progress) => {
      log.info('onProgress proc')
      state(sId).port.postMessage({
        type: `onExportProgress/${id}`,
        input: progress
      })
    })

    await exporter.exportToFile()
  },

  'export/cancel': async function({ id, sId }: { id: string, sId: string }) {
    const exporter = getExporter(id, sId);

    return exporter.abort();
  }
}
