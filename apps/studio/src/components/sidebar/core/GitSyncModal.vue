<template>
  <div class="git-sync-settings">
    <form @submit.prevent="save">
      <div
        v-if="error"
        class="alert alert-danger"
      >
        {{ error }}
      </div>
      <div class="form-group">
        <label>Git repository folder</label>
        <file-picker
          v-model="form.repoPath"
          :options="{ properties: ['openDirectory'] }"
          button-text="Choose Directory"
        />
        <small class="help text-muted">
          A folder that is already a git clone. The system <code>git</code> is used, so your SSH keys and credential helper apply.
        </small>
      </div>
      <div class="form-group">
        <label>Sub-folder for queries (optional)</label>
        <input
          v-model="form.subdir"
          type="text"
          class="form-control"
          placeholder="e.g. sql/queries"
        >
        <small class="help text-muted">Each saved query is one <code>.sql</code> file in this folder. Leave empty to use the repository folder itself.</small>
      </div>
      <div class="form-group row flex-middle auto-fetch-row">
        <label class="checkbox-group">
          <input
            v-model="form.autoFetch"
            type="checkbox"
          >
          <span>Auto fetch every</span>
        </label>
        <input
          v-model.number="form.interval"
          type="number"
          min="1"
          class="form-control interval-input"
          :disabled="!form.autoFetch"
        >
        <span>minutes</span>
      </div>
      <small class="help text-muted">
        Fetch only checks for new commits. It never changes your saved queries or the working folder. You pull and push yourself.
      </small>
      <div class="vue-dialog-buttons">
        <button
          v-if="config.repoPath"
          class="btn btn-flat btn-danger-text"
          type="button"
          @click.prevent="disconnect"
        >
          Disconnect
        </button>
        <span class="expand" />
        <button
          class="btn btn-flat"
          type="button"
          @click.prevent="$emit('done')"
        >
          Cancel
        </button>
        <button
          class="btn btn-primary"
          type="submit"
          :disabled="working || !form.repoPath"
        >
          Save
        </button>
      </div>
    </form>
  </div>
</template>

<script lang="ts">
import Vue from 'vue'
import FilePicker from '@/components/common/form/FilePicker.vue'

export default Vue.extend({
  components: { FilePicker },
  props: {
    config: { type: Object, required: true },
  },
  data() {
    return {
      form: { ...this.config },
      error: null as string | null,
      working: false,
    }
  },
  methods: {
    async save() {
      this.working = true
      this.error = null
      try {
        const saved = await this.$util.send('gitSync/config/set', { config: this.form })
        this.$emit('saved', saved)
      } catch (e) {
        this.error = String(e?.message || e).split(/\s+Stack:/)[0]
      } finally {
        this.working = false
      }
    },
    async disconnect() {
      this.working = true
      try {
        const saved = await this.$util.send('gitSync/config/set', { config: { ...this.form, repoPath: '', subdir: '' } })
        this.$emit('saved', saved)
      } catch (e) {
        this.error = String(e?.message || e).split(/\s+Stack:/)[0]
      } finally {
        this.working = false
      }
    },
  },
})
</script>
