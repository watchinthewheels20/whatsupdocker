<template>
  <v-container fluid class="pa-4">
    <v-card class="border" elevation="0" rounded="lg">
      <div class="d-flex flex-wrap align-center ga-3 pa-4">
        <div class="flex-grow-1">
          <h1 class="text-h6">Update schedules</h1>
          <p class="text-body-2 text-medium-emphasis">
            Check for and apply updates to containers or entire Compose stacks.
          </p>
        </div>
        <v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :loading="loading"
          @click="load"
          >Refresh</v-btn
        >
        <v-btn
          v-if="canWrite"
          color="primary"
          variant="flat"
          prepend-icon="mdi-calendar-plus"
          @click="edit()"
          >Create schedule</v-btn
        >
      </div>
      <v-alert v-if="error" type="error" variant="tonal" class="mx-4 mb-4">{{
        error
      }}</v-alert>
      <v-data-table
        :items="schedules"
        :headers="headers"
        :loading="loading"
        item-value="id"
      >
        <template #[`item.target`]="{ item }">
          <div>
            {{
              item.target.composeProject && item.scope === "stack"
                ? item.target.composeProject
                : item.target.name
            }}
          </div>
          <div class="text-caption text-medium-emphasis">
            {{ item.target.watcher }} ·
            {{ item.scope === "stack" ? "Entire Compose stack" : "Container" }}
          </div>
        </template>
        <template #[`item.cron`]="{ item }"
          ><code>{{ item.cron }}</code>
          <div class="text-caption">{{ item.timezone }}</div></template
        >
        <template #[`item.nextRunAt`]="{ item }"
          >{{
            item.enabled ? formatDate(item.nextRunAt, item.timezone) : "Paused"
          }}
          <div class="text-caption text-medium-emphasis">
            {{ item.timezone }}
          </div></template
        >
        <template #[`item.lastStatus`]="{ item }"
          ><div>{{ item.lastStatus || "Not run yet" }}</div>
          <div class="text-caption">
            {{ formatDate(item.lastRunAt, item.timezone)
            }}<span v-if="item.lastRunAt"> · {{ item.timezone }}</span>
          </div>
          <div v-if="item.lastError" class="text-error text-caption">
            {{ item.lastError }}
          </div></template
        >
        <template #[`item.enabled`]="{ item }"
          ><v-switch
            :model-value="item.enabled"
            :disabled="!canWrite || busyId === item.id"
            :aria-label="`${item.enabled ? 'Pause' : 'Enable'} ${item.name}`"
            color="primary"
            hide-details
            density="compact"
            @update:model-value="toggle(item)"
        /></template>
        <template #[`item.actions`]="{ item }"
          ><div v-if="canWrite" class="d-flex">
            <v-btn
              icon="mdi-play-outline"
              variant="text"
              size="small"
              :aria-label="`Run ${item.name} now`"
              :disabled="Boolean(busyId)"
              @click="runTarget = item"
            />
            <v-btn
              icon="mdi-pencil-outline"
              variant="text"
              size="small"
              :aria-label="`Edit ${item.name}`"
              :disabled="Boolean(busyId)"
              @click="edit(item)"
            />
            <v-btn
              icon="mdi-delete-outline"
              variant="text"
              size="small"
              color="error"
              :aria-label="`Delete ${item.name}`"
              :disabled="Boolean(busyId)"
              @click="deleteTarget = item"
            /></div
        ></template>
        <template #no-data
          ><div class="pa-8">
            No update schedules yet. Create a schedule here or from a
            container’s actions.
          </div></template
        >
      </v-data-table>
    </v-card>
    <schedule-dialog
      v-model="dialog"
      :containers="containers"
      :schedule="selectedSchedule"
      @saved="load"
    />
    <v-dialog
      :model-value="Boolean(deleteTarget)"
      max-width="480"
      :persistent="Boolean(busyId)"
      @update:model-value="deleteTarget = undefined"
      ><v-card title="Delete schedule?"
        ><v-card-text
          >Delete {{ deleteTarget?.name }}? This stops its future scheduled
          runs.</v-card-text
        ><v-card-actions class="justify-end"
          ><v-btn :disabled="Boolean(busyId)" @click="deleteTarget = undefined"
            >Cancel</v-btn
          ><v-btn color="error" :loading="Boolean(busyId)" @click="remove"
            >Delete</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog
      :model-value="Boolean(runTarget)"
      max-width="520"
      :persistent="Boolean(busyId)"
      @update:model-value="runTarget = undefined"
      ><v-card title="Run schedule now?"
        ><v-card-text
          >Check for and apply updates for {{ runTarget?.name }}.
          {{
            runTarget?.scope === "stack"
              ? "Every service in this Compose stack is included."
              : "The target container may restart."
          }}</v-card-text
        ><v-card-actions class="justify-end"
          ><v-btn :disabled="Boolean(busyId)" @click="runTarget = undefined"
            >Cancel</v-btn
          ><v-btn color="primary" :loading="Boolean(busyId)" @click="run"
            >Run now</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog v-model="showResults" max-width="640"
      ><v-card title="Update results"
        ><v-card-text
          ><v-list
            ><v-list-item
              v-for="(result, index) in results"
              :key="index"
              :title="`${result.name}: ${result.status}`"
              :subtitle="result.message" /></v-list></v-card-text
        ><v-card-actions class="justify-end"
          ><v-btn @click="showResults = false">Close</v-btn></v-card-actions
        ></v-card
      ></v-dialog
    >
  </v-container>
</template>
<script lang="ts">
import { defineComponent } from "vue";
import ScheduleDialog from "@/components/ScheduleDialog.vue";
import { getUser } from "@/services/auth";
import { getAllContainers } from "@/services/container";
import {
  deleteSchedule,
  listSchedules,
  runSchedule,
  updateSchedule,
  UpdateContainer,
  UpdateResult,
  UpdateSchedule,
} from "@/services/update";
export default defineComponent({
  components: { ScheduleDialog },
  data: () => ({
    schedules: [] as UpdateSchedule[],
    containers: [] as UpdateContainer[],
    canWrite: false,
    loading: false,
    error: "",
    busyId: "",
    dialog: false,
    selectedSchedule: undefined as UpdateSchedule | undefined,
    deleteTarget: undefined as UpdateSchedule | undefined,
    runTarget: undefined as UpdateSchedule | undefined,
    showResults: false,
    results: [] as UpdateResult[],
    headers: [
      { title: "Name", key: "name" },
      { title: "Target", key: "target", sortable: false },
      { title: "Frequency", key: "cron" },
      { title: "Next run", key: "nextRunAt" },
      { title: "Last result", key: "lastStatus" },
      { title: "Enabled", key: "enabled" },
      { title: "Actions", key: "actions", sortable: false },
    ],
  }),
  async mounted() {
    try {
      const user = await getUser();
      this.canWrite = user?.role === "admin" || user?.role === "rw";
    } catch {
      this.canWrite = false;
    }
    await this.load();
  },
  methods: {
    async load() {
      this.loading = true;
      this.error = "";
      try {
        [this.schedules, this.containers] = await Promise.all([
          listSchedules(),
          getAllContainers(),
        ]);
      } catch (error) {
        this.fail(error);
      } finally {
        this.loading = false;
      }
    },
    fail(error: unknown) {
      this.error = error instanceof Error ? error.message : String(error);
    },
    edit(schedule?: UpdateSchedule) {
      this.selectedSchedule = schedule;
      this.dialog = true;
    },
    formatDate(value?: string | null, timezone = "Europe/London") {
      if (!value) return "—";
      try {
        return new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value));
      } catch {
        return value;
      }
    },
    async toggle(schedule: UpdateSchedule) {
      if (!this.canWrite || this.busyId) return;
      this.busyId = schedule.id;
      this.error = "";
      try {
        await updateSchedule(schedule.id, { enabled: !schedule.enabled });
        await this.load();
      } catch (error) {
        this.fail(error);
      } finally {
        this.busyId = "";
      }
    },
    async remove() {
      if (!this.deleteTarget || !this.canWrite || this.busyId) return;
      this.busyId = this.deleteTarget.id;
      this.error = "";
      try {
        await deleteSchedule(this.deleteTarget.id);
        this.deleteTarget = undefined;
        await this.load();
      } catch (error) {
        this.fail(error);
      } finally {
        this.busyId = "";
      }
    },
    async run() {
      if (!this.runTarget || !this.canWrite || this.busyId) return;
      this.busyId = this.runTarget.id;
      this.error = "";
      try {
        this.results = (await runSchedule(this.runTarget.id)).results;
        this.runTarget = undefined;
        this.showResults = true;
        await this.load();
      } catch (error) {
        this.fail(error);
      } finally {
        this.busyId = "";
      }
    },
  },
});
</script>
