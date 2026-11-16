<template>
  <div class="git-sync">
    <div class="git-sync-bar">
      <div class="git-sync-line">
        <i
          class="material-icons branch-icon"
          :title="configured && status && status.upstream ? `Tracking ${status.upstream}` : 'Git sync'"
        >call_split</i>
        <span
          v-if="configured"
          class="branch expand"
        >{{ status ? status.branch : '…' }}</span>
        <span
          v-else
          class="branch expand muted"
        >Git sync off</span>
        <span
          v-if="configured && status && status.behind"
          class="badge behind"
          :title="`${status.behind} commit(s) to pull`"
        >↓{{ status.behind }}</span>
        <span
          v-if="configured && status && status.ahead"
          class="badge ahead"
          :title="`${status.ahead} commit(s) to push`"
        >↑{{ status.ahead }}</span>
        <a
          class="refresh"
          :class="{ spinning: busy === 'fetch' }"
          :title="configured ? 'Update: fetch from git and reload saved queries' : 'Reload saved queries'"
          @click.prevent="update"
        >
          <i class="material-icons">refresh</i>
        </a>
        <a
          class="settings"
          title="Git sync settings"
          @click.prevent="openSettings"
        >
          <i class="material-icons">settings</i>
        </a>
      </div>
      <template v-if="configured">
        <div class="git-sync-buttons">
          <button
            class="btn btn-small btn-flat"
            :class="{ 'btn-primary': status && status.behind > 0 }"
            :disabled="!!busy"
            title="Fetch, fast-forward and import queries from the repository"
            @click.prevent="doPull"
          >
            <i class="material-icons">file_download</i>
            Pull
          </button>
          <button
            class="btn btn-small btn-flat"
            :class="{ 'btn-primary': status && (status.pendingPush > 0 || status.ahead > 0) }"
            :disabled="!!busy"
            title="Write changed queries to the repository, commit and push"
            @click.prevent="doPush"
          >
            <i class="material-icons">file_upload</i>
            Push
            <span
              v-if="status && status.pendingPush"
              class="count"
            >{{ status.pendingPush }}</span>
          </button>
        </div>
        <div
          v-if="message"
          class="git-sync-message"
          :class="message.kind"
        >
          {{ message.text }}
        </div>
      </template>
    </div>

    <portal to="modals">
      <modal
        class="vue-dialog beekeeper-modal git-sync-modal"
        name="git-sync-settings"
        height="auto"
        :scrollable="true"
      >
        <div
          v-if="config"
          v-kbd-trap="true"
          class="dialog-content"
        >
          <div class="dialog-c-title">
            Sync saved queries with git
          </div>
          <git-sync-modal
            :config="config"
            @saved="settingsSaved"
            @done="$modal.hide('git-sync-settings')"
          />
        </div>
      </modal>
      <modal
        class="vue-dialog beekeeper-modal git-sync-modal"
        name="git-sync-conflicts"
        height="auto"
        :scrollable="true"
        :click-to-close="false"
      >
        <div
          v-kbd-trap="true"
          class="dialog-content"
        >
          <div class="dialog-c-title">
            {{ conflicts.length }} {{ conflicts.length === 1 ? 'query was' : 'queries were' }} changed in the app and in git
          </div>
          <p class="text-muted">
            Nothing was overwritten. Choose what to keep for each one.
          </p>
          <div
            v-for="c in conflicts"
            :key="c.title"
            class="conflict"
          >
            <div class="conflict-title">
              {{ c.title }}
            </div>
            <div class="conflict-versions">
              <div>
                <div class="label">
                  In the app
                </div>
                <pre>{{ c.local.text }}</pre>
              </div>
              <div>
                <div class="label">
                  In git
                </div>
                <pre>{{ c.repo.text }}</pre>
              </div>
            </div>
            <div class="conflict-choice">
              <label><input
                v-model="choices[c.title]"
                type="radio"
                value="local"
              > Keep the app version</label>
              <label><input
                v-model="choices[c.title]"
                type="radio"
                value="repo"
              > Take the git version</label>
              <label><input
                v-model="choices[c.title]"
                type="radio"
                value="both"
              > Keep both</label>
            </div>
          </div>
          <div class="vue-dialog-buttons">
            <span class="expand" />
            <button
              class="btn btn-flat"
              @click.prevent="$modal.hide('git-sync-conflicts')"
            >
              Decide later
            </button>
            <button
              class="btn btn-primary"
              :disabled="busy === 'resolve'"
              @click.prevent="applyResolutions"
            >
              Apply
            </button>
          </div>
        </div>
      </modal>
    </portal>
  </div>
</template>

<script lang="ts">
import Vue from 'vue'
import GitSyncModal from './GitSyncModal.vue'

const SETTINGS_EVENT = 'gitSync:settings'

/** the utility channel appends " Stack: ..." to error messages; users only need the first part */
function describe(e: any): string {
  return String(e?.message || e).split(/\s+Stack:/)[0]
}

export default Vue.extend({
  components: { GitSyncModal },
  data() {
    return {
      config: null as any,
      status: null as any,
      busy: null as null | 'fetch' | 'pull' | 'push' | 'resolve',
      message: null as null | { kind: 'info' | 'error', text: string },
      conflicts: [] as any[],
      choices: {} as Record<string, string>,
      timer: null as any,
    }
  },
  computed: {
    configured(): boolean {
      return !!(this.config && this.config.repoPath)
    },
  },
  async mounted() {
    this.$root.$on(SETTINGS_EVENT, this.openSettings)
    await this.loadConfig()
    await this.refresh(true)
  },
  beforeDestroy() {
    this.$root.$off(SETTINGS_EVENT, this.openSettings)
    this.stopTimer()
  },
  methods: {
    async loadConfig() {
      try {
        this.config = await this.$util.send('gitSync/config/get')
      } catch (e) {
        this.config = null
      }
      this.restartTimer()
    },
    restartTimer() {
      this.stopTimer()
      if (this.configured && this.config.autoFetch) {
        this.timer = setInterval(() => this.refresh(true, true), Math.max(1, this.config.interval) * 60 * 1000)
      }
    },
    stopTimer() {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
    },
    openSettings() {
      this.$modal.show('git-sync-settings')
    },
    async settingsSaved(saved: any) {
      this.config = saved
      this.status = null
      this.message = null
      this.$modal.hide('git-sync-settings')
      this.restartTimer()
      await this.refresh(true)
    },
    /** @param quiet a background fetch must not interrupt with errors while the user is busy */
    async refresh(doFetch: boolean, quiet = false) {
      if (!this.configured || (quiet && this.busy)) return
      try {
        this.status = await this.$util.send('gitSync/status', { fetch: doFetch })
        if (!quiet) this.message = null
      } catch (e) {
        this.message = { kind: 'error', text: describe(e) }
      }
    },
    /** The one refresh button: fetch from git when configured, and always reload the saved queries. */
    async update() {
      if (this.busy) return
      this.busy = 'fetch'
      try {
        await this.reloadQueries()
        if (this.configured) await this.refresh(true)
      } finally {
        this.busy = null
      }
    },
    async reloadQueries() {
      await this.$store.dispatch('data/queries/load')
    },
    async doPull() {
      this.busy = 'pull'
      this.message = null
      try {
        const r = await this.$util.send('gitSync/pull')
        await this.reloadQueries()
        const parts = [] as string[]
        if (r.created.length) parts.push(`${r.created.length} new`)
        if (r.updated.length) parts.push(`${r.updated.length} updated`)
        const text = parts.length ? `Pulled: ${parts.join(', ')}.` : (r.conflicts.length ? '' : 'Already up to date.')
        const need = r.conflicts.length ? ` ${r.conflicts.length} conflict(s) need a decision.` : ''
        this.message = { kind: 'info', text: `${text}${need}`.trim() }
        if (r.warnings.length) this.message.text += ` ${r.warnings[0]}`
        this.showConflicts(r.conflicts)
      } catch (e) {
        this.message = { kind: 'error', text: describe(e) }
      } finally {
        this.busy = null
        await this.refresh(false, true)
      }
    },
    async doPush() {
      this.busy = 'push'
      this.message = null
      try {
        const r = await this.$util.send('gitSync/push')
        const parts = [] as string[]
        if (r.written.length) parts.push(`${r.written.length} query file(s) written`)
        if (r.pushed) parts.push('pushed')
        if (r.needPull.length) parts.push(`${r.needPull.length} changed in git, pull to receive`)
        this.message = { kind: 'info', text: parts.length ? `${parts.join(', ')}.` : 'Nothing to push.' }
        this.showConflicts(r.conflicts)
      } catch (e) {
        this.message = { kind: 'error', text: describe(e) }
      } finally {
        this.busy = null
        await this.refresh(false, true)
      }
    },
    showConflicts(conflicts: any[]) {
      if (!conflicts || !conflicts.length) return
      this.conflicts = conflicts
      this.choices = Object.fromEntries(conflicts.map((c) => [c.title, 'local']))
      this.$modal.show('git-sync-conflicts')
    },
    async applyResolutions() {
      this.busy = 'resolve'
      try {
        const resolutions = this.conflicts.map((c) => ({ title: c.title, choice: this.choices[c.title] }))
        await this.$util.send('gitSync/resolve', { resolutions })
        await this.reloadQueries()
        this.$modal.hide('git-sync-conflicts')
        this.message = { kind: 'info', text: 'Resolved. Push to send the kept versions to git.' }
        this.conflicts = []
      } catch (e) {
        this.message = { kind: 'error', text: describe(e) }
      } finally {
        this.busy = null
        await this.refresh(false, true)
      }
    },
  },
})
</script>
