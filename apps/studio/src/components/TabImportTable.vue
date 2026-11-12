<template>
  <div class="import-file-tab">
    <div class="import-file-wrap">
      <div class="import-file-header">
        <h2>Import into <span class="table-name">{{ tableTitle }}</span></h2>
        <ol class="import-steps">
          <li
            v-for="(s, i) in steps"
            :key="s"
            :class="{ active: step === i, done: step > i }"
          >
            <span class="step-number">{{ i + 1 }}</span> {{ s }}
          </li>
        </ol>
      </div>

      <div
        v-if="loadError"
        class="alert alert-danger"
      >
        <i class="material-icons">error_outline</i>
        <div>{{ loadError }}</div>
      </div>

      <!-- 1. File -->
      <section
        v-show="step === 0"
        class="card-flat padding"
      >
        <div class="form-group">
          <label>File (CSV, TSV, TXT or Excel .xlsx)</label>
          <file-picker
            v-model="filePath"
            :options="fileOptions"
            input-id="import-file-picker"
          />
        </div>
        <div class="import-options-grid">
          <div
            v-if="format === 'xlsx' && sample && sample.sheets"
            class="form-group"
          >
            <label for="import-sheet">Worksheet</label>
            <select
              id="import-sheet"
              v-model="sheet"
            >
              <option
                v-for="name in sample.sheets"
                :key="name"
                :value="name"
              >
                {{ name }}
              </option>
            </select>
          </div>
          <template v-if="format === 'csv'">
            <div class="form-group">
              <label for="import-delimiter">Delimiter</label>
              <select
                id="import-delimiter"
                v-model="delimiter"
              >
                <option value="">
                  Detect
                </option>
                <option value=",">
                  Comma ,
                </option>
                <option value=";">
                  Semicolon ;
                </option>
                <option :value="tabChar">
                  Tab
                </option>
                <option value="|">
                  Pipe |
                </option>
              </select>
            </div>
            <div class="form-group">
              <label for="import-quote">Quote character</label>
              <select
                id="import-quote"
                v-model="quoteChar"
              >
                <option value="&quot;">
                  Double quote "
                </option>
                <option value="'">
                  Single quote '
                </option>
              </select>
            </div>
            <div class="form-group">
              <label for="import-encoding">Encoding</label>
              <select
                id="import-encoding"
                v-model="encoding"
              >
                <option
                  v-for="e in encodings"
                  :key="e.value"
                  :value="e.value"
                >
                  {{ e.label }}
                </option>
              </select>
            </div>
          </template>
          <div class="form-group">
            <label class="checkbox-group">
              <input
                type="checkbox"
                v-model="hasHeader"
              >
              <span>First row is header</span>
            </label>
            <input
              v-if="hasHeader"
              type="number"
              min="1"
              v-model.number="headerRow"
              title="Header row number"
            >
          </div>
          <div class="form-group">
            <label for="import-first-row">First data row</label>
            <input
              id="import-first-row"
              type="number"
              min="1"
              v-model.number="firstDataRow"
              :placeholder="String(defaultFirstRow)"
            >
          </div>
          <div class="form-group">
            <label for="import-last-row">Last data row</label>
            <input
              id="import-last-row"
              type="number"
              min="1"
              v-model.number="lastDataRow"
              placeholder="End of file"
            >
          </div>
        </div>

        <div
          v-if="sampleError"
          class="alert alert-danger"
        >
          <i class="material-icons">error_outline</i>
          <div>{{ sampleError }}</div>
        </div>
        <div
          v-else-if="sampling"
          class="import-hint"
        >
          Reading the file...
        </div>
        <div
          v-else-if="sample"
          class="import-table-scroll"
        >
          <table class="import-grid">
            <thead>
              <tr>
                <th class="row-number">
                  Row
                </th>
                <th
                  v-for="(c, i) in sample.columns"
                  :key="i"
                >
                  {{ c }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in sample.rows.slice(0, 10)"
                :key="r.rowNumber"
              >
                <td class="row-number">
                  {{ r.rowNumber }}
                </td>
                <td
                  v-for="(c, i) in sample.columns"
                  :key="i"
                >
                  {{ display(r.values[i]) }}
                </td>
              </tr>
            </tbody>
          </table>
          <div
            v-if="!sample.rows.length"
            class="import-hint"
          >
            No data rows in the chosen range.
          </div>
        </div>
      </section>

      <!-- 2. Mapping -->
      <section
        v-show="step === 1"
        class="card-flat padding"
      >
        <p class="import-hint">
          File columns are matched to table columns by name. Choose a table column for each file column, or skip it.
          Tick the key columns used to match file rows to table rows{{ tableInfo && tableInfo.primaryKey.length ? ' (the primary key by default)' : '' }}.
        </p>
        <table class="import-grid mapping">
          <thead>
            <tr>
              <th>File column</th>
              <th>Sample</th>
              <th>Table column</th>
              <th>Key</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="m in mappings"
              :key="m.fileIndex"
              :class="{ skipped: !m.tableColumn }"
            >
              <td>{{ m.fileColumn }}</td>
              <td class="sample-value">
                {{ sampleValue(m.fileIndex) }}
              </td>
              <td>
                <select
                  v-model="m.tableColumn"
                  @change="mappingChanged"
                >
                  <option :value="null">
                    Skip
                  </option>
                  <option
                    v-for="c in tableColumns"
                    :key="c.name"
                    :value="c.name"
                  >
                    {{ c.name }} ({{ c.dataType }})
                  </option>
                </select>
              </td>
              <td>
                <input
                  type="checkbox"
                  :disabled="!m.tableColumn"
                  :checked="m.tableColumn && keyColumns.includes(m.tableColumn)"
                  @change="toggleKey(m.tableColumn, $event.target.checked)"
                >
              </td>
            </tr>
          </tbody>
        </table>
        <import-messages :messages="mappingWarnings" />
      </section>

      <!-- 3. Mode and options -->
      <section
        v-show="step === 2"
        class="card-flat padding"
      >
        <div class="import-modes">
          <label
            v-for="m in modeList"
            :key="m.mode"
            class="import-mode"
            :class="{ disabled: !m.enabled, selected: mode === m.mode }"
          >
            <input
              type="radio"
              :value="m.mode"
              v-model="mode"
              :disabled="!m.enabled"
            >
            <div>
              <div class="mode-title">{{ m.title }}</div>
              <div class="mode-description">{{ m.description }}</div>
              <div
                v-if="m.note"
                class="mode-note"
              >{{ m.note }}</div>
            </div>
          </label>
        </div>
        <div
          v-if="keyedMode"
          class="import-hint"
        >
          Key columns: <strong>{{ keyColumns.length ? keyColumns.join(', ') : 'none chosen' }}</strong>
          <a
            href=""
            @click.prevent="step = 1"
          >change</a>
        </div>
        <div class="import-options-grid">
          <div class="form-group">
            <label
              class="checkbox-group"
              :class="{ disabled: !supportsTransactions }"
            >
              <input
                type="checkbox"
                v-model="useTransaction"
                :disabled="!supportsTransactions"
              >
              <span>Run in one transaction</span>
            </label>
          </div>
          <div class="form-group">
            <label class="checkbox-group">
              <input
                type="checkbox"
                v-model="emptyAsNull"
              >
              <span>Treat empty values as NULL</span>
            </label>
          </div>
          <div class="form-group">
            <label for="import-errors">On error</label>
            <select
              id="import-errors"
              v-model="errorMode"
            >
              <option value="stop">
                Stop on the first error
              </option>
              <option value="continue">
                Continue and collect errors
              </option>
            </select>
          </div>
          <div class="form-group">
            <label for="import-batch">Batch size</label>
            <input
              id="import-batch"
              type="number"
              min="1"
              max="10000"
              v-model.number="batchSize"
            >
          </div>
          <div class="form-group">
            <label for="import-decimal">Decimal separator</label>
            <select
              id="import-decimal"
              v-model="decimalSeparator"
            >
              <option value=".">
                Point 12.5
              </option>
              <option value=",">
                Comma 12,5
              </option>
            </select>
          </div>
          <div class="form-group">
            <label for="import-date">Date format</label>
            <input
              id="import-date"
              type="text"
              list="import-date-formats"
              v-model="dateFormat"
            >
            <datalist id="import-date-formats">
              <option
                v-for="f in dateFormats"
                :key="f"
                :value="f"
              />
            </datalist>
          </div>
        </div>
        <import-messages
          :messages="check.problems"
          kind="danger"
        />
        <import-messages :messages="check.warnings" />
      </section>

      <!-- 4. Preview and run -->
      <section
        v-show="step === 3"
        class="card-flat padding"
      >
        <template v-if="!jobId">
          <p class="import-plan">
            <strong>{{ modeTitle }}</strong> into <strong>{{ tableTitle }}</strong>
            <template v-if="keyedMode">
              matching on <strong>{{ keyColumns.join(', ') }}</strong>
            </template>
            &middot; {{ useTransaction && supportsTransactions ? 'one transaction' : 'no transaction' }}
            &middot; {{ errorMode === 'stop' ? 'stop on first error' : 'continue on errors' }}
            &middot; batches of {{ batchSize }}
          </p>
          <import-messages
            :messages="check.problems"
            kind="danger"
          />
          <import-messages :messages="check.warnings" />
          <div
            v-if="previewError"
            class="alert alert-danger"
          >
            <i class="material-icons">error_outline</i>
            <div>{{ previewError }}</div>
          </div>
          <div
            v-else
            class="import-table-scroll"
          >
            <p class="import-hint">
              The first rows as they will be written:
            </p>
            <table class="import-grid">
              <thead>
                <tr>
                  <th class="row-number">
                    Row
                  </th>
                  <th
                    v-for="c in mappedColumns"
                    :key="c"
                  >
                    {{ c }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in preview"
                  :key="r.rowNumber"
                  :class="{ 'has-error': r.errors.length }"
                >
                  <td class="row-number">
                    {{ r.rowNumber }}
                  </td>
                  <td
                    v-for="c in mappedColumns"
                    :key="c"
                    :class="{ 'cell-error': cellError(r, c) }"
                    :title="cellError(r, c) || null"
                  >
                    <span
                      v-if="r.values[c] === null || r.values[c] === undefined"
                      class="null-value"
                    >(NULL)</span>
                    <template v-else>
                      {{ display(r.values[c]) }}
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <div
          v-else
          class="import-run"
        >
          <div
            v-if="!summary"
            class="import-progress"
          >
            <x-progressbar />
            <p>Importing... {{ progress.read.toLocaleString() }} rows read</p>
          </div>
          <div
            v-else
            class="alert"
            :class="summaryClass"
          >
            <i class="material-icons">{{ summary.status === 'completed' ? 'check_circle' : summary.status === 'cancelled' ? 'block' : 'error_outline' }}</i>
            <div>
              <div class="summary-title">
                {{ summaryTitle }}
              </div>
              <div v-if="summary.error">
                {{ summary.error }}
              </div>
              <div v-if="summary.rolledBack">
                All changes were rolled back, so the table is as it was before the import.
              </div>
            </div>
          </div>
          <dl class="import-counts">
            <template v-for="c in countList">
              <dt :key="c.key + '-t'">
                {{ c.label }}
              </dt>
              <dd
                :key="c.key + '-v'"
                :class="c.key"
              >
                {{ (summary || progress)[c.key].toLocaleString() }}
              </dd>
            </template>
            <template v-if="summary">
              <dt>Time</dt>
              <dd>{{ elapsed }}</dd>
            </template>
          </dl>
          <div
            v-if="summary && summary.errors.length"
            class="import-failed"
          >
            <div class="failed-header">
              <span>Failed rows{{ summary.failed > summary.errors.length ? ` (first ${summary.errors.length} of ${summary.failed})` : '' }}</span>
              <a
                class="btn btn-flat btn-small"
                @click.prevent="copyErrors"
              >Copy</a>
            </div>
            <ul>
              <li
                v-for="(e, i) in summary.errors.slice(0, 200)"
                :key="i"
              >
                <strong>Row {{ e.rowNumber }}</strong>: {{ e.message }}
              </li>
            </ul>
          </div>
        </div>
      </section>

      <div class="import-actions">
        <button
          v-if="step > 0 && !running"
          class="btn btn-flat"
          type="button"
          @click="back"
        >
          {{ summary ? 'Import again' : 'Back' }}
        </button>
        <span class="expand" />
        <button
          v-if="step < 3"
          class="btn btn-primary"
          type="button"
          :disabled="!canNext"
          @click="next"
        >
          Next
        </button>
        <template v-else>
          <button
            v-if="running"
            class="btn btn-flat"
            type="button"
            @click="cancel"
          >
            Cancel import
          </button>
          <button
            v-else-if="summary"
            class="btn btn-primary"
            type="button"
            @click="viewTable"
          >
            View table
          </button>
          <button
            v-else
            class="btn btn-primary"
            type="button"
            :disabled="!!check.problems.length || checking"
            @click="run"
          >
            Run import
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import Vue from 'vue'
import _ from 'lodash'
import FilePicker from '@/components/common/form/FilePicker.vue'
import { AppEvent } from '@/common/AppEvent'

const ImportMessages = Vue.extend({
  props: { messages: { type: Array, default: () => [] }, kind: { type: String, default: 'warning' } },
  render(h) {
    if (!this.messages.length) return h()
    return h('div', { class: ['alert', `alert-${this.kind}`, 'import-messages'] }, [
      h('i', { class: 'material-icons' }, this.kind === 'danger' ? 'error_outline' : 'warning'),
      h('ul', this.messages.map((m) => h('li', m))),
    ])
  },
})

const modeInfo = {
  append: { title: 'Append', description: 'Insert every row from the file.' },
  update: { title: 'Update', description: 'Update table rows whose key matches a file row. File rows without a match are skipped.' },
  appendUpdate: { title: 'Append/Update', description: 'Update table rows whose key matches a file row, and insert the other file rows.' },
  appendNoUpdate: { title: 'Append without update', description: 'Insert file rows whose key is not in the table. Matching table rows are left unchanged.' },
  delete: { title: 'Delete', description: 'Delete table rows whose key matches a file row.' },
  copy: { title: 'Copy', description: 'Delete every row in the table, then insert every row from the file.' },
}
const keyedModes = ['update', 'appendUpdate', 'appendNoUpdate', 'delete']

export default Vue.extend({
  components: { FilePicker, ImportMessages },
  props: {
    tab: { type: Object, required: true },
    active: { type: Boolean, default: false },
  },
  data() {
    return {
      steps: ['File', 'Columns', 'Mode and options', 'Preview and run'],
      step: 0,
      tabChar: '\t',
      loadError: null,
      support: null,
      tableInfo: null,
      // file
      filePath: null,
      sheet: null,
      delimiter: '',
      quoteChar: '"',
      encoding: 'utf-8',
      hasHeader: true,
      headerRow: 1,
      firstDataRow: null,
      lastDataRow: null,
      sample: null,
      sampleError: null,
      sampling: false,
      // mapping
      mappings: [],
      mappedFor: null,
      keyColumns: [],
      // options
      mode: 'append',
      useTransaction: true,
      emptyAsNull: true,
      errorMode: 'stop',
      batchSize: 500,
      decimalSeparator: '.',
      dateFormat: 'YYYY-MM-DD',
      check: { problems: [], warnings: [] },
      checking: false,
      // preview and run
      preview: [],
      previewError: null,
      jobId: null,
      progress: null,
      summary: null,
      listeners: [],
      encodings: [
        { value: 'utf-8', label: 'UTF-8' },
        { value: 'windows-1252', label: 'Windows-1252 (Western)' },
        { value: 'iso-8859-1', label: 'ISO-8859-1 (Latin-1)' },
        { value: 'iso-8859-15', label: 'ISO-8859-15 (Latin-9)' },
        { value: 'utf-16le', label: 'UTF-16 LE' },
        { value: 'utf-16be', label: 'UTF-16 BE' },
        { value: 'windows-1250', label: 'Windows-1250 (Central European)' },
        { value: 'windows-1251', label: 'Windows-1251 (Cyrillic)' },
        { value: 'shift_jis', label: 'Shift JIS' },
        { value: 'gbk', label: 'GBK' },
        { value: 'big5', label: 'Big5' },
        { value: 'euc-kr', label: 'EUC-KR' },
      ],
      dateFormats: ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY', 'DD-MM-YYYY', 'YYYY/MM/DD', 'D/M/YYYY', 'M/D/YYYY', 'DD/MM/YY'],
    }
  },
  computed: {
    target() {
      return { table: this.tab.tableName, schema: this.tab.schemaName || null }
    },
    tableTitle() {
      return this.tab.schemaName ? `${this.tab.schemaName}.${this.tab.tableName}` : this.tab.tableName
    },
    fileOptions() {
      return {
        buttonLabel: 'Choose',
        properties: ['openFile'],
        filters: [
          { name: 'CSV or Excel', extensions: ['csv', 'tsv', 'txt', 'xlsx'] },
          { name: 'All files', extensions: ['*'] },
        ],
      }
    },
    format() {
      return /\.xlsx$/i.test(this.filePath || '') ? 'xlsx' : 'csv'
    },
    defaultFirstRow() {
      return this.hasHeader ? (this.headerRow || 1) + 1 : 1
    },
    parse() {
      const csv = this.format === 'csv'
        ? { delimiter: this.filePath && /\.tsv$/i.test(this.filePath) && !this.delimiter ? '\t' : this.delimiter, quoteChar: this.quoteChar, encoding: this.encoding }
        : undefined
      return {
        format: this.format,
        csv,
        sheet: this.format === 'xlsx' ? this.sheet || undefined : undefined,
        headerRow: this.hasHeader ? this.headerRow || 1 : null,
        firstDataRow: this.firstDataRow || undefined,
        lastDataRow: this.lastDataRow || null,
      }
    },
    tableColumns() {
      return this.tableInfo ? this.tableInfo.columns.filter((c) => !c.generated) : []
    },
    mappedColumns() {
      return this.mappings.filter((m) => m.tableColumn).map((m) => m.tableColumn)
    },
    supportsTransactions() {
      return !!this.support?.transactions
    },
    modeList() {
      const modes = this.support?.modes || Object.keys(modeInfo).map((mode) => ({ mode, enabled: true }))
      return modes.map((m) => ({ ...m, ...modeInfo[m.mode] }))
    },
    modeTitle() {
      return modeInfo[this.mode].title
    },
    keyedMode() {
      return keyedModes.includes(this.mode)
    },
    request() {
      return {
        filePath: this.filePath,
        parse: this.parse,
        target: this.target,
        mappings: this.mappings.map((m) => ({ fileIndex: m.fileIndex, fileColumn: m.fileColumn, tableColumn: m.tableColumn })),
        options: {
          mode: this.mode,
          keyColumns: this.keyedMode ? this.keyColumns : [],
          useTransaction: this.useTransaction && this.supportsTransactions,
          batchSize: this.batchSize || 500,
          errorMode: this.errorMode,
          decimalSeparator: this.decimalSeparator,
          dateFormat: this.dateFormat,
          emptyAsNull: this.emptyAsNull,
        },
      }
    },
    mappingWarnings() {
      const required = this.tableColumns.filter((c) => !c.nullable && !c.hasDefault && !this.mappedColumns.includes(c.name))
      const messages = []
      if (!this.mappedColumns.length) messages.push('No file column is mapped to a table column yet.')
      if (required.length) {
        messages.push(`These columns can't be empty and have no default: ${required.map((c) => c.name).join(', ')}. Map them, or rows inserted by Append, Append/Update, Append without update or Copy will fail.`)
      }
      return messages
    },
    canNext() {
      if (this.step === 0) return !!(this.sample && !this.sampleError && !this.sampling && this.sample.rows.length)
      if (this.step === 1) return this.mappedColumns.length > 0
      if (this.step === 2) return !this.check.problems.length && !this.checking
      return false
    },
    running() {
      return !!this.jobId && !this.summary
    },
    countList() {
      return [
        { key: 'read', label: 'Rows read' },
        { key: 'inserted', label: 'Inserted' },
        { key: 'updated', label: 'Updated' },
        { key: 'deleted', label: 'Deleted' },
        { key: 'skipped', label: 'Skipped' },
        { key: 'failed', label: 'Failed' },
        { key: 'duplicateKeys', label: 'Duplicate keys in file' },
      ]
    },
    summaryClass() {
      if (!this.summary) return ''
      if (this.summary.status === 'completed') return this.summary.failed ? 'alert-warning' : 'alert-success'
      return this.summary.status === 'cancelled' ? 'alert-warning' : 'alert-danger'
    },
    summaryTitle() {
      const s = this.summary
      if (!s) return ''
      if (s.status === 'cancelled') return 'The import was cancelled.'
      if (s.status === 'failed') return 'The import stopped because of an error.'
      return s.failed ? `Import finished with ${s.failed.toLocaleString()} failed ${s.failed === 1 ? 'row' : 'rows'}.` : 'Import finished.'
    },
    elapsed() {
      const ms = this.summary?.elapsedMs || 0
      if (ms < 1000) return `${ms} ms`
      const seconds = ms / 1000
      return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
    },
  },
  watch: {
    parse: {
      deep: true,
      handler() {
        this.loadSample()
      },
    },
    request: {
      deep: true,
      handler() {
        if (this.step >= 2 && !this.jobId) this.runCheck()
      },
    },
    mode(mode) {
      if (keyedModes.includes(mode) && !this.keyColumns.length) this.defaultKeys()
    },
  },
  async mounted() {
    try {
      const [support, tableInfo] = await Promise.all([
        this.$util.send('import/support', {}),
        this.$util.send('import/table', { target: this.target }),
      ])
      this.support = support
      this.tableInfo = tableInfo
      if (!support.transactions) this.useTransaction = false
    } catch (e) {
      this.loadError = e.message || String(e)
    }
  },
  beforeDestroy() {
    this.listeners.forEach((id) => this.$util.removeListener(id))
  },
  methods: {
    display(value) {
      if (value === null || value === undefined) return ''
      const text = String(value)
      return text.length > 80 ? text.slice(0, 77) + '...' : text
    },
    sampleValue(index) {
      const row = this.sample?.rows.find((r) => r.values[index] !== null && r.values[index] !== undefined && r.values[index] !== '')
      return row ? this.display(row.values[index]) : ''
    },
    loadSample: _.debounce(async function () {
      if (!this.filePath) return
      this.sampling = true
      this.sampleError = null
      try {
        const sample = await this.$util.send('import/sample', { filePath: this.filePath, parse: this.parse, limit: 20 })
        if (this.format === 'xlsx' && !this.sheet && sample.sheets?.length) this.sheet = sample.sheets[0]
        this.sample = sample
      } catch (e) {
        this.sample = null
        this.sampleError = (e.message || String(e)).replace(/^Error: /, '')
      } finally {
        this.sampling = false
      }
    }, 250),
    async autoMap() {
      const signature = JSON.stringify(this.sample.columns)
      if (this.mappedFor === signature) return
      this.mappings = await this.$util.send('import/autoMap', {
        fileColumns: this.sample.columns,
        tableColumns: this.tableColumns.map((c) => c.name),
      })
      this.mappedFor = signature
      this.keyColumns = []
      this.defaultKeys()
    },
    defaultKeys() {
      const pk = this.tableInfo?.primaryKey || []
      if (pk.length && pk.every((k) => this.mappedColumns.includes(k))) this.keyColumns = [...pk]
    },
    mappingChanged() {
      this.keyColumns = this.keyColumns.filter((k) => this.mappedColumns.includes(k))
    },
    toggleKey(column, on) {
      this.keyColumns = on ? _.uniq([...this.keyColumns, column]) : this.keyColumns.filter((k) => k !== column)
    },
    runCheck: _.debounce(async function () {
      this.checking = true
      try {
        this.check = await this.$util.send('import/check', { request: this.request })
      } catch (e) {
        this.check = { problems: [e.message || String(e)], warnings: [] }
      } finally {
        this.checking = false
      }
    }, 200),
    async loadPreview() {
      this.previewError = null
      try {
        this.preview = await this.$util.send('import/preview', { request: this.request, limit: 25 })
      } catch (e) {
        this.preview = []
        this.previewError = e.message || String(e)
      }
    },
    cellError(row, column) {
      const e = row.errors.find((x) => x.column === column)
      return e ? e.message : null
    },
    async next() {
      if (!this.canNext) return
      if (this.step === 0) await this.autoMap()
      this.step++
      if (this.step >= 2) {
        this.checking = true
        this.runCheck()
      }
      if (this.step === 3) this.loadPreview()
    },
    back() {
      if (this.summary) {
        // start over with the same settings
        this.jobId = null
        this.summary = null
        this.progress = null
        this.loadPreview()
        return
      }
      this.step--
    },
    async run() {
      if (this.mode === 'copy') {
        const info = await this.$util.send('import/table', { target: this.target }).catch(() => this.tableInfo)
        const count = info?.rowCount
        const rows = count === null || count === undefined ? 'all its rows' : `its ${count.toLocaleString()} ${count === 1 ? 'row' : 'rows'}`
        const ok = await this.$confirm(
          `Delete every row in ${this.tableTitle}?`,
          `Copy mode deletes ${this.tableTitle} and ${rows} before importing the file.${this.supportsTransactions && this.useTransaction ? '' : " This can't be undone."}`,
          { confirmLabel: 'Delete rows and import' }
        )
        if (!ok) return
      }
      this.summary = null
      this.progress = { read: 0, inserted: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, duplicateKeys: 0 }
      try {
        const id = await this.$util.send('import/start', { request: this.request })
        this.jobId = id
        this.listeners.push(this.$util.addListener(`onImportProgress/${id}`, (p) => { this.progress = p }))
        this.listeners.push(this.$util.addListener(`onImportDone/${id}`, (s) => this.finished(s)))
        // the import may have finished before the listener was added
        const done = await this.$util.send('import/result', { id })
        if (done) this.finished(done)
      } catch (e) {
        this.jobId = null
        this.$noty.error(`The import could not start: ${e.message || e}`)
      }
    },
    finished(summary) {
      if (this.summary) return
      this.summary = summary
      this.progress = summary
      this.$util.send('import/remove', { id: this.jobId }).catch(() => undefined)
    },
    async cancel() {
      if (this.jobId) await this.$util.send('import/cancel', { id: this.jobId })
    },
    copyErrors() {
      const text = this.summary.errors.map((e) => `Row ${e.rowNumber}: ${e.message}`).join('\n')
      this.$copyText(text)
      this.$noty.info('Failed rows copied')
    },
    viewTable() {
      this.$root.$emit(AppEvent.loadTable, {
        table: { name: this.tab.tableName, schema: this.tab.schemaName, entityType: 'table' },
      })
    },
  },
})
</script>
