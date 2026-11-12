import { IConnectionHandlers } from "./connHandlers";
import { IExportHandlers } from "./exportHandlers";
import { IGeneratorHandlers } from "./generatorHandlers";
import { IImportHandlers } from "./importHandlers";
import { IQueryHandlers } from "./queryHandlers";

export interface Handlers extends
  IConnectionHandlers,
  IQueryHandlers,
  IGeneratorHandlers,
  IExportHandlers,
  IImportHandlers
   {};
