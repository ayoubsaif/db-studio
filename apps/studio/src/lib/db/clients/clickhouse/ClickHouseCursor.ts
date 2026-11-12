import type { ClickHouseClient, ClickHouseSettings } from '@clickhouse/client';
import type { Readable } from 'stream';
import rawLog from 'electron-log';
import { BeeCursor } from '../../models';
import { waitFor } from '../base/wait';

const log = rawLog.scope('clickhouse/cursor');

/**
 * Streams a query's rows as arrays (`JSONCompactEachRow`), handing them out in
 * chunks. The HTTP stream is paused while a chunk is waiting to be read, so
 * memory stays bounded no matter how many rows the query returns.
 */
export class ClickHouseCursor extends BeeCursor {
  private stream?: Readable;
  private abort = new AbortController();
  private buffer: any[][] = [];
  private ended = false;
  private error?: Error;

  constructor(
    private client: ClickHouseClient,
    private query: string,
    chunkSize: number,
    private settings: ClickHouseSettings = {}
  ) {
    super(chunkSize);
  }

  async start(): Promise<void> {
    const result = await this.client.query({
      query: this.query,
      format: 'JSONCompactEachRow',
      abort_signal: this.abort.signal,
      clickhouse_settings: this.settings,
    });
    this.stream = result.stream() as unknown as Readable;
    this.stream.on('data', (rows: { json(): any[] }[]) => {
      for (const row of rows) this.buffer.push(row.json());
      if (this.buffer.length >= this.chunkSize) this.stream.pause();
    });
    this.stream.on('end', () => { this.ended = true });
    this.stream.on('error', (err) => {
      // an abort we asked for isn't an error
      if (this.abort.signal.aborted) {
        this.ended = true;
        return;
      }
      log.error('stream error', err);
      this.error = err;
    });
  }

  async read(): Promise<any[][]> {
    await waitFor(() => this.buffer.length >= this.chunkSize || this.ended || !!this.error);
    if (this.error) throw this.error;
    const chunk = this.buffer.splice(0, this.chunkSize);
    if (!this.ended && this.buffer.length < this.chunkSize) this.stream?.resume();
    return chunk;
  }

  async cancel(): Promise<void> {
    if (this.ended) return;
    this.abort.abort();
    this.stream?.destroy();
    this.ended = true;
  }
}
