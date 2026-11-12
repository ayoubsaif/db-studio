<template>
  <div>
    <modal
      class="vue-dialog beekeeper-modal export-modal"
      name="export-modal"
      height="auto"
      :scrollable="true"
      @closed="$emit('closed')"
    >
      <!-- TODO: Make sure one of the elements in this modal is focused so that the keyboard trap works -->
      <form
        v-kbd-trap="true"
        @submit.prevent="submit"
      >
        <div class="dialog-content">
          <div class="dialog-c-title flex flex-middle">
            <div v-if="multiMode">
              Export
              <span class="text-primary">{{ selectedTables.length }} {{ selectedTables.length === 1 ? 'table' : 'tables' }}</span>
            </div>
            <div v-else>
              Export
              <span class="text-primary truncate">{{ table ? table.name : queryName }}</span>
              <span
                v-if="filters"
                class="text-light"
                v-tooltip="filterTooltip"
              >(Filtered)</span>
              <span class="badge badge-info">Beta</span>
            </div>
          </div>

          <template v-if="multiMode">
            <p>
              Each table is exported to its own file in the folder you choose, one after another,
              in the background.
            </p>
            <p
              v-if="hasFilters"
              class="text-muted"
            >
              Filters aren't applied when exporting multiple tables; every row is exported.
            </p>
          </template>
          <template v-else>
            <p>This will {{ table ? 'export table rows' : 'run your query and save the results' }}  directly to a file.</p>
            <p>You can choose the format and file name.</p>
            <p>
              For {{ table ? 'tables with many' : 'queries with many results' }} rows, this will run in the background,
              allowing you to continue to do other work.
            </p>
          </template>

          <span class="close-btn btn btn-fab">
            <i
              class="material-icons"
              @click.prevent="closeModal"
            >clear</i>
          </span>
          <div
            v-if="error"
            class="alert alert-danger"
          >
            <i class="material-icons">error_outline</i>
            <div>Error: {{ error.message }}</div>
          </div>
          <div class="modal-form export-form">
            <!-- Tables (multi-table export) -->
            <div
              v-if="multiMode"
              class="form-group"
            >
              <label>Tables</label>
              <export-table-picker
                :tables="allTables"
                v-model="selectedTables"
              />
            </div>
            <div class="flex">
              <!-- File Name -->
              <div
                v-if="!multiMode"
                class="file-name form-group expand"
              >
                <label for="fileName">File Name</label>
                <input
                  type="text"
                  spellcheck="false"
                  v-model="fileName"
                >
              </div>

              <!-- Format -->
              <div class="format form-group">
                <label for="connectionType">Format</label>
                <select
                  name="connectionType"
                  class="form-control custom-select"
                  v-model="selectedExportFormat"
                  id="export-format-select"
                >
                  <option
                    disabled
                    value="null"
                  >
                    Select a format...
                  </option>
                  <option
                    :key="f.value"
                    v-for="f in exportFormats"
                    :value="f"
                    :selected="selectedExportFormat === f.value"
                    :disabled="(f.name === 'SQL' && queryName) ? true : false"
                  >
                    {{ f.name }}
                  </option>
                </select>
              </div>
            </div>

            <!-- Location -->
            <div class="form-group">
              <label for="fileDirectory">Output Directory</label>
              <file-picker
                v-model="fileDirectory"
                :default-path="defaultPath"
                :save="false"
                :options="dialogOptions"
                button-text="Choose"
              />
            </div>

            <!-- Existing files (multi-table export) -->
            <div
              v-if="multiMode"
              class="form-group"
            >
              <label for="existingFiles">If a file already exists</label>
              <select
                id="existingFiles"
                class="form-control custom-select"
                v-model="existingFiles"
              >
                <option value="number">
                  Keep it and add a number to the new file
                </option>
                <option value="overwrite">
                  Overwrite it
                </option>
                <option value="skip">
                  Skip that table
                </option>
              </select>
            </div>

            <!-- Advanced Options -->
            <div
              class="advanced-options-toggle flex flex-middle"
              @click.prevent="toggleAdvanced"
            >
              <i class="material-icons">{{ toggleIcon }}</i>
              <span>Advanced Options</span>
            </div>
            <div
              class="advanced-options"
              :class="{open: advancedToggled}"
            >
              <component
                :is="selectedExportFormat.component"
                v-model="outputOptions"
              />
              <div class="modal-form export-form export-advanced-options">
                <div class="form-group row">
                  <label title="How many records to read at once from the cursor">Chunk size</label>
                  <input
                    v-model="options.chunkSize"
                    type="number"
                    class="form-control"
                    ref="paramInput"
                    min="10"
                    step="10"
                  >
                </div>
                <div class="form-group row">
                  <label
                    for="deleteOnAbort"
                    class="checkbox-group"
                  >
                    <input
                      v-model="options.deleteOnAbort"
                      id="deleteOnAbort"
                      type="checkbox"
                      name="deleteOnAbort"
                      class="form-control"
                    >
                    <span>Delete file on abort/error</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="vue-dialog-buttons">
          <button
            v-if="!multiMode && table"
            class="btn btn-flat btn-icon"
            type="button"
            @click.prevent="switchToMultiple"
          >
            <i class="material-icons">tab</i>
            Export multiple tables
          </button>
          <span v-else />
          <button
            class="btn btn-primary"
            type="submit"
            :disabled="!canSubmit"
          >
            Run
          </button>
        </div>
      </form>
    </modal>
  </div>
</template>
<script>
import dateFormat from 'dateformat'
import { mapMutations } from "vuex"
import rawlog from 'electron-log'
import { ExportFormCSV, ExportFormJSON, ExportFormSQL, ExportFormJsonLine, ExportFormXLSX } from "./forms"
import FilePicker from '../common/form/FilePicker.vue'
import ExportTablePicker from './ExportTablePicker.vue'
const log = rawlog.scope('export/export-modal')

const exportFormats = [
  {
    name: "CSV",
    key: "csv",
    component: ExportFormCSV,
  },
  {
    name: "JSON",
    key: "json",
    component: ExportFormJSON,
  },
  {
    name: 'JSON Lines',
    key: 'jsonl',
    component: ExportFormJsonLine
  },
  {
    name: 'Excel',
    key: 'xlsx',
    component: ExportFormXLSX,
  },
  {
    name: "SQL",
    key: "sql",
    component: ExportFormSQL,
  },
]

export default {
  components: { FilePicker, ExportTablePicker },
  // `multiple` opens the multi-table export with `tables` pre-selected
  props: ['table', 'query', 'queryName', 'filters', 'multiple', 'tables'],
  data() {
    return {
      selectedExportFormat: exportFormats[0],
      exportFormats,
      options: { chunkSize: 100, deleteOnAbort: true, includeFilter: true },
      outputOptions: {},
      error: null,
      fileDirectory: null,
      fileName: null,
      advancedToggled: false,
      multiMode: !!this.multiple,
      selectedTables: this.tables ? [...this.tables] : [],
      existingFiles: 'number',
    };
  },
  watch: {
    table() {
      if (this.table) {
        this.$modal.show("export-modal");
      }
    },
    multiple() {
      if (this.multiple) {
        this.multiMode = true
        this.selectedTables = this.tables ? [...this.tables] : []
        this.$modal.show("export-modal");
      }
    },
    query() {
      if (this.query) {
        this.$modal.show("export-modal");
      }
    },
    fileDirectory() {
      if (this.fileDirectory) {
        localStorage.setItem('export/directory', this.fileDirectory)
      }
    },
    selectedExportFormat() {
      if (!this.fileName) return
      const split = this.fileName.split('.')
      if (split.length < 2) return
      split[split.length - 1] = this.selectedExportFormat.key
      this.fileName = split.join(".")
    }
  },
  computed: {
    defaultFileName () {
      const now = new Date();
      const formatted = dateFormat(now, 'yyyy-mm-dd_HHMMss')
      const extension = this.selectedExportFormat.key
      let fileName;
      if (!this.table && !this.queryName) {
        // multi-table export: each table gets its own file name
        return ''
      }
      if (this.table) {
        const schema = this.table.schema ? `${this.table.schema}_` : ''
        const extension = this.selectedExportFormat.key
        fileName = `${schema}${this.table.name}_export_${formatted}.${extension}`
      } else {
        // sanitize query name for use as filename
        let queryFileName = this.queryName.replace(/[^a-z0-9]/gi, '_').toLowerCase()
        queryFileName = queryFileName.replace(/_+/gi, '_') // avoid double-underscores
        queryFileName = queryFileName.replace(/^_/gi, '')   // remove any leading underscore
        queryFileName = queryFileName.replace(/_$/gi, '')   // remove any trailing underscore
        fileName = `${queryFileName}_${formatted}.${extension}`
      }
      return fileName
    },
    filePath() {
      if (!this.fileDirectory || !this.fileName) return null
      return window.main.join(this.fileDirectory, this.fileName)
    },
    allTables() {
      return this.$store.state.tables || []
    },
    canSubmit() {
      if (this.multiMode) return !!this.fileDirectory && this.selectedTables.length > 0
      return !!this.filePath
    },
    dialogOptions() {
      const result = { buttonLabel: 'Choose Directory', properties: [ 'openDirectory', 'createDirectory'] }
      return result
    },
    hasFilters() {
      return this.filters && this.filters.length;
    },
    defaultPath() {
      let previous = localStorage.getItem('export/directory')
      if (previous === 'undefined' || previous === 'null') previous = null
      return previous || this.$config.downloadsDirectory
    },
    filterTooltip() {
      if (!this.hasFilters) {
        return null;
      }
      return JSON.stringify(this.filters, null, 2);
    },
    filterCount() {
      if (!this.hasFilters) {
        return null;
      } else if (typeof this.filters === "string") {
        return 1;
      } else {
        return this.filters.length;
      }
    },
    toggleIcon() {
      return this.advancedToggled ? 'keyboard_arrow_down' : 'keyboard_arrow_right'
    },
  },
  methods: {
    async submit() {
      this.error = null;

      if (!this.canSubmit) {
        return;
      }

      if (this.multiMode) {
        this.$emit('exportMany', { // handled by ExportManager
          tables: this.selectedTables,
          directory: this.fileDirectory,
          existing: this.existingFiles,
          exporter: this.selectedExportFormat.key,
          options: this.options,
          outputOptions: this.outputOptions,
        })
        this.$modal.hide('export-modal')
        return
      }

      // eslint-disable-next-line
      const component = this;

      const payload = {
        table: this.table,
        query: this.query,
        queryName: this.queryName,
        filters: this.filters,
        filePath: this.filePath,
        options: this.options,
        outputOptions: this.outputOptions,
        exporter: this.selectedExportFormat.key
      }
      this.$emit('export', payload) // handled by ExportManager
      this.$modal.hide('export-modal')
    },
    closeModal () {
      this.$modal.hide('export-modal')
    },
    switchToMultiple() {
      this.selectedTables = this.table ? [this.table] : []
      this.multiMode = true
    },
    toggleAdvanced() {
      this.advancedToggled = !this.advancedToggled
    }
  },
  mounted() {
    this.fileDirectory = this.defaultPath
    this.fileName = this.defaultFileName
    this.$modal.show("export-modal");
  },
};
</script>
