<template>
  <div class="export-manager">
    <ExportModal
      v-if="table || query || multiple"
      :table="table"
      :query="query"
      :query-name="queryName"
      :filters="filters"
      :multiple="multiple"
      :tables="tables"
      @export="startExport"
      @exportMany="startMultiExport"
      @closed="handleDeadModal"
    />
    <ExportSummaryModal
      v-if="summary"
      :results="summary.results"
      :headline="summary.headline"
      @closed="summary = null"
    />
    <!-- TODO (@day): the exports will just be an array of ids -->
    <ExportNotification
      v-for="exportId in exports"
      :key="exportId"
      :exportId="exportId"
    />
  </div>
</template>
<script lang="ts">
import Vue from 'vue'
import Noty from 'noty'
import { mapGetters, mapMutations } from 'vuex'
import { AppEvent, RootBinding } from '../../common/AppEvent'
import { TableFilter, TableOrView } from '../../lib/db/models'
import ExportNotification from './ExportNotification.vue'
import ExportModal from './ExportModal.vue'
import ExportSummaryModal from './ExportSummaryModal.vue'
import {
  ExportProgress, ExportStatus, MultiExportRequest, MultiExportTableResult, StartExportOptions
} from '../../lib/export/models'
import { MultiExportResult, startMultiExport, summarizeMultiExport } from '../../lib/export/multiQueue'
import globals from '@/common/globals'
import { escapeHtml } from '@shared/lib/tabulator'

interface ExportTriggerOptions {
  table?: TableOrView,
  query?: string,
  queryName?: string,
  filters?: TableFilter[],
  // open the multi-table export with these tables selected
  multiple?: boolean,
  tables?: TableOrView[]
}

export default Vue.extend({
  components: { ExportModal, ExportNotification, ExportSummaryModal },
  props: [],
  data() {
    return {
      // these are like 'pending Export'
      table: (undefined as TableOrView | undefined),
      query: '',
      queryName: '',
      filters: (undefined as TableFilter[] | undefined),
      multiple: false,
      tables: (undefined as TableOrView[] | undefined),
      summary: (null as { headline: string, results: MultiExportTableResult[] } | null),
    }
  },
  computed: {
    ...mapGetters({ exports: "exports/exports" }),
    rootBindings(): RootBinding[] {
      return [
        { event: AppEvent.beginExport, handler: this.handleExportRequest },
      ]
    }
  },
  methods: {
    ...mapMutations({ addExport: "exports/addExport" }),
    async startExport(options: StartExportOptions) {
      const id = await this.$util.send('export/add', {options});
      this.addExport(id);

      const exportName = options.table ? options.table.name : options.queryName;

      await this.$util.send('export/start', {id});
      const status = await this.$util.send('export/status', {id});

      if (status == ExportStatus.Error) {
        const error = await this.$util.send('export/error', {id});
        const error_notice = this.$noty.error(`Export of ${exportName} failed: ${error}`, {
          buttons: [
            Noty.button('Close', "btn btn-primary", () => {
              error_notice.close()
            })
          ]
        }).setTimeout(globals.errorNoticeTimeout)
        return
      }
      if (status !== ExportStatus.Completed) return;
      const warnings: string[] = await this.$util.send('export/warnings', {id});
      const message = [`Export of ${exportName} complete.`, ...warnings].join(' ');
      const n = this.$noty[warnings.length ? 'warning' : 'success'](message, {
        buttons: [
          Noty.button('Show', "btn btn-primary", () => {
            this.$native.files.showItemInFolder(options.filePath)
            n.close()
          })
        ]
      })
    },
    /**
     * Exports each table to its own file, one after another. A failed table
     * doesn't stop the rest; cancelling stops the current table and skips the rest.
     */
    async startMultiExport(request: MultiExportRequest) {
      let job = null
      const progress = new Noty({
        text: '',
        layout: 'bottomRight',
        timeout: false,
        closeWith: ['button'],
        queue: 'export',
        buttons: [
          Noty.button('Cancel', 'btn btn-flat', () => job?.cancel()),
          Noty.button('Hide', 'btn btn-primary', () => progress.close()),
        ],
      })
      progress.show()

      job = startMultiExport(request, {
        send: (name, args) => this.$util.send(name, args),
        addListener: (type, listener: (p: ExportProgress) => void) => this.$util.addListener(type, listener),
        removeListener: (id) => this.$util.removeListener(id),
        onProgress: (position, total, name, rows) => {
          progress.setText(escapeHtml(
            `Exporting tables (${position} of ${total}): ${name}, ${rows.toLocaleString()} rows`
          ))
        },
      })
      const outcome = await job.done
      progress.close()
      this.showMultiSummary(outcome, request.directory)
    },
    showMultiSummary(outcome: MultiExportResult, directory: string) {
      const { results } = outcome
      const { headline, hasProblems } = summarizeMultiExport(outcome)
      const failed = results.some((r) => r.outcome === 'failed')

      const lastFile = [...results].reverse().find((r) => r.filePath)?.filePath
      const notice = this.$noty[hasProblems ? 'warning' : 'success'](headline, {
        // keep problem summaries up longer; otherwise use the default timeout
        ...(hasProblems ? { timeout: globals.errorNoticeTimeout } : {}),
        buttons: [
          Noty.button('Details', 'btn btn-flat', () => {
            this.summary = { headline, results }
            notice.close()
          }),
          Noty.button('Show', 'btn btn-primary', () => {
            this.$native.files.showItemInFolder(lastFile || directory)
            notice.close()
          }),
        ]
      })
      // failures are easy to miss in a toast, so open the details right away
      if (failed) this.summary = { headline, results }
    },
    handleExportRequest(options?: ExportTriggerOptions): void {
      this.table = options?.table
      this.query = options?.query
      this.queryName = options?.queryName
      this.filters = options?.filters
      this.tables = options?.tables || (options?.table ? [options.table] : undefined)
      this.multiple = !!options?.multiple
    },
    handleDeadModal() {
      this.table = undefined
      this.filters = undefined
      this.query = undefined
      this.queryName = undefined
      this.multiple = false
      this.tables = undefined
    },
    notifyProgress(_progress: ExportProgress) {
      // Empty on purpose
    }
  },
  mounted() {
    this.registerHandlers(this.rootBindings)
  },
  beforeDestroy() {
    this.unregisterHandlers(this.rootBindings)
  }
})
</script>
