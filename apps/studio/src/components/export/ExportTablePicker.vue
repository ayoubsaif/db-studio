<template>
  <div class="export-table-picker">
    <div class="picker-toolbar flex flex-middle">
      <input
        v-model="search"
        type="text"
        class="form-control"
        placeholder="Filter tables"
        spellcheck="false"
      >
      <span class="picker-count text-muted">{{ value.length }} of {{ allTables.length }} selected</span>
    </div>
    <div class="picker-list">
      <div
        v-for="group in visibleGroups"
        :key="group.key"
        class="picker-group"
      >
        <label
          v-if="showSchemas"
          class="checkbox-group picker-schema"
        >
          <input
            type="checkbox"
            class="form-control"
            :checked="groupState(group) === 'all'"
            :indeterminate.prop="groupState(group) === 'some'"
            @change="toggleGroup(group, $event.target.checked)"
          >
          <span>{{ group.schema }}</span>
        </label>
        <label
          v-for="table in group.tables"
          :key="keyFor(table)"
          class="checkbox-group picker-table"
          :class="{ indented: showSchemas }"
        >
          <input
            type="checkbox"
            class="form-control"
            :checked="selectedKeys.has(keyFor(table))"
            @change="toggleTable(table, $event.target.checked)"
          >
          <span>{{ table.name }}</span>
          <span
            v-if="table.entityType && table.entityType !== 'table'"
            class="text-muted picker-kind"
          >{{ kindLabel(table.entityType) }}</span>
        </label>
      </div>
      <p
        v-if="!visibleGroups.length"
        class="text-muted"
      >
        No tables match.
      </p>
    </div>
    <div class="picker-actions">
      <a @click.prevent="selectVisible(true)">Select all</a>
      <span class="text-muted">&middot;</span>
      <a @click.prevent="selectVisible(false)">Select none</a>
    </div>
  </div>
</template>

<script lang="ts">
import Vue, { PropType } from 'vue'
import _ from 'lodash'
import { TableOrView } from '@/lib/db/models'
import { tableKey } from '@/lib/export/tableKey'

interface Group {
  key: string
  schema: string | null
  tables: TableOrView[]
}

export default Vue.extend({
  props: {
    tables: {
      type: Array as PropType<TableOrView[]>,
      required: true,
    },
    // selected tables (v-model)
    value: {
      type: Array as PropType<TableOrView[]>,
      required: true,
    },
  },
  data() {
    return { search: '' }
  },
  computed: {
    allTables(): TableOrView[] {
      return this.tables
    },
    groups(): Group[] {
      return _.chain(this.tables)
        .groupBy((t) => t.schema || '')
        .map((tables, schema) => ({
          key: schema,
          schema: schema || null,
          tables: _.sortBy(tables, (t) => t.name.toLowerCase()),
        }))
        .sortBy((g) => (g.schema || '').toLowerCase())
        .value()
    },
    showSchemas(): boolean {
      return this.groups.length > 1 || !!this.groups[0]?.schema
    },
    visibleGroups(): Group[] {
      const term = this.search.trim().toLowerCase()
      if (!term) return this.groups
      return this.groups
        .map((g) => ({ ...g, tables: g.tables.filter((t) => t.name.toLowerCase().includes(term)) }))
        .filter((g) => g.tables.length)
    },
    selectedKeys(): Set<string> {
      return new Set(this.value.map(tableKey))
    },
  },
  methods: {
    keyFor(table: TableOrView): string {
      return tableKey(table)
    },
    kindLabel(entityType: string): string {
      return entityType === 'materialized-view' ? 'materialized view' : entityType
    },
    groupState(group: Group): 'all' | 'some' | 'none' {
      const count = group.tables.filter((t) => this.selectedKeys.has(tableKey(t))).length
      if (count === 0) return 'none'
      return count === group.tables.length ? 'all' : 'some'
    },
    emitSelection(keys: Set<string>) {
      // keep the sidebar's order so files are exported in a predictable order
      this.$emit('input', this.tables.filter((t) => keys.has(tableKey(t))))
    },
    toggleTable(table: TableOrView, checked: boolean) {
      const keys = new Set(this.selectedKeys)
      if (checked) keys.add(tableKey(table))
      else keys.delete(tableKey(table))
      this.emitSelection(keys)
    },
    toggleGroup(group: Group, checked: boolean) {
      const keys = new Set(this.selectedKeys)
      group.tables.forEach((t) => (checked ? keys.add(tableKey(t)) : keys.delete(tableKey(t))))
      this.emitSelection(keys)
    },
    selectVisible(checked: boolean) {
      const keys = new Set(this.selectedKeys)
      this.visibleGroups.forEach((g) => g.tables.forEach((t) => (checked ? keys.add(tableKey(t)) : keys.delete(tableKey(t)))))
      this.emitSelection(keys)
    },
  },
})
</script>

<style lang="scss" scoped>
.export-table-picker {
  margin-bottom: 1rem;
}
.picker-toolbar {
  gap: 0.75rem;
  margin-bottom: 0.5rem;
  input {
    flex: 1;
  }
}
.picker-count {
  white-space: nowrap;
}
.picker-list {
  max-height: 260px;
  overflow-y: auto;
  padding: 0.25rem 0;
}
.picker-schema {
  font-weight: 600;
}
.picker-table.indented {
  padding-left: 1.5rem;
}
.picker-kind {
  margin-left: 0.5rem;
  font-size: 0.85em;
}
.picker-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
  a {
    cursor: pointer;
  }
}
</style>
