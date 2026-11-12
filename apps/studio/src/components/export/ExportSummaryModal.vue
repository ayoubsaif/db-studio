<template>
  <modal
    class="vue-dialog beekeeper-modal export-summary-modal"
    name="export-summary-modal"
    height="auto"
    :scrollable="true"
    @closed="$emit('closed')"
  >
    <div class="dialog-content">
      <div class="dialog-c-title">
        Export summary
      </div>
      <p>{{ headline }}</p>
      <div class="summary-table">
        <table class="table">
          <thead>
            <tr>
              <th>Table</th>
              <th>Result</th>
              <th class="text-right">
                Rows
              </th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, i) in results"
              :key="i"
              :class="`outcome-${r.outcome.replace(' ', '-')}`"
            >
              <td class="truncate">
                {{ r.name }}
              </td>
              <td>{{ r.outcome }}</td>
              <td class="text-right">
                {{ r.outcome === 'exported' || r.rows ? r.rows.toLocaleString() : '' }}
              </td>
              <td class="summary-message">
                {{ r.message || (r.filePath ? fileName(r.filePath) : '') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="vue-dialog-buttons">
      <button
        class="btn btn-flat"
        type="button"
        @click.prevent="copy"
      >
        Copy
      </button>
      <button
        class="btn btn-primary"
        type="button"
        @click.prevent="$modal.hide('export-summary-modal')"
      >
        Close
      </button>
    </div>
  </modal>
</template>

<script lang="ts">
import Vue, { PropType } from 'vue'
import { MultiExportTableResult } from '@/lib/export/models'

export default Vue.extend({
  props: {
    results: {
      type: Array as PropType<MultiExportTableResult[]>,
      required: true,
    },
    headline: {
      type: String,
      required: true,
    },
  },
  methods: {
    fileName(filePath: string): string {
      return filePath.split(/[\\/]/).pop() || filePath
    },
    copy() {
      const lines = this.results.map((r) => [r.name, r.outcome, r.rows, r.message || r.filePath || ''].join('\t'))
      this.$copyText([this.headline, 'Table\tResult\tRows\tDetails', ...lines].join('\n'))
    },
  },
  mounted() {
    this.$modal.show('export-summary-modal')
  },
})
</script>

<style lang="scss" scoped>
.summary-table {
  max-height: 320px;
  overflow-y: auto;
  table {
    width: 100%;
  }
  td, th {
    padding: 0.25rem 0.5rem;
  }
}
.summary-message {
  word-break: break-word;
}
.outcome-failed td {
  color: var(--brand-danger, #e85f5f);
}
</style>
