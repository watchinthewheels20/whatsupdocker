<template>
  <v-dialog
    :model-value="modelValue"
    max-width="640"
    :persistent="saving"
    @update:model-value="close"
  >
    <v-card rounded="lg">
      <v-card-title class="pt-5">{{
        schedule ? "Edit update schedule" : "Create update schedule"
      }}</v-card-title>
      <v-card-text>
        <v-progress-linear
          v-if="loading"
          indeterminate
          aria-label="Loading schedule options"
        />
        <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{
          error
        }}</v-alert>
        <v-text-field
          v-model="name"
          label="Schedule name"
          variant="outlined"
          :disabled="saving"
        />
        <v-select
          v-if="!schedule"
          v-model="containerId"
          :items="containerOptions"
          item-title="label"
          item-value="id"
          label="Container"
          variant="outlined"
          :disabled="saving"
        />
        <p v-else class="mb-4">
          Target: {{ schedule.target.name }} ({{ schedule.target.watcher }})
        </p>
        <v-select
          v-model="scope"
          :items="scopeOptions"
          item-title="label"
          item-value="value"
          label="Update scope"
          variant="outlined"
          :disabled="saving"
        />
        <p v-if="stackReason" class="text-caption mb-3">
          Whole-stack update unavailable: {{ stackReason }}
        </p>
        <v-alert
          v-if="scope === 'stack'"
          type="info"
          variant="tonal"
          class="mb-4"
          >Checks and updates every service in this Compose stack, including
          services without their own schedule.</v-alert
        >
        <v-select
          v-model="triggerId"
          :items="triggerOptions"
          item-title="label"
          item-value="id"
          label="Update trigger"
          variant="outlined"
          :disabled="saving"
        />
        <v-alert
          v-if="selectedTrigger?.dryrun"
          type="warning"
          variant="tonal"
          class="mb-4"
          >This trigger uses dry run mode. Containers will not be
          changed.</v-alert
        >
        <v-select
          v-model="preset"
          :items="presets"
          item-title="label"
          item-value="value"
          label="Frequency"
          variant="outlined"
          :disabled="saving"
        />
        <div v-if="preset !== 'custom'" class="d-flex flex-wrap ga-3">
          <v-text-field
            v-model="time"
            type="time"
            label="Time"
            variant="outlined"
            :disabled="saving"
          />
          <v-select
            v-if="preset === 'weekly'"
            v-model="weekday"
            :items="weekdays"
            item-title="label"
            item-value="value"
            label="Day"
            variant="outlined"
            :disabled="saving"
          />
        </div>
        <v-text-field
          v-else
          v-model="customCron"
          label="Cron expression"
          hint="Five fields: minute hour day-of-month month day-of-week. Example: 0 3 * * 0"
          persistent-hint
          variant="outlined"
          :disabled="saving"
          class="mb-3"
        />
        <v-text-field
          v-model="timezone"
          label="Timezone"
          hint="IANA timezone, e.g. Europe/London. Follows local daylight saving time."
          persistent-hint
          variant="outlined"
          :disabled="saving"
          class="mb-3"
        />
        <p class="text-caption mb-2">Cron: {{ cron }} · {{ timezone }}</p>
        <v-switch
          v-model="enabled"
          label="Schedule enabled"
          color="primary"
          :disabled="saving"
          hide-details
        />
        <p class="text-caption mt-3">
          At each scheduled time, check for updates and apply available updates.
          Services may restart.
        </p>
      </v-card-text>
      <v-card-actions class="pa-4 justify-end">
        <v-btn :disabled="saving" @click="close">Cancel</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="saving"
          :disabled="!valid || loading"
          @click="save"
          >Save schedule</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
<script lang="ts">
import { defineComponent, PropType } from "vue";
import {
  createSchedule,
  getUpdateOptions,
  stackAvailability,
  updateSchedule,
  UpdateContainer,
  UpdateOptions,
  UpdateSchedule,
  UpdateScope,
} from "@/services/update";
export default defineComponent({
  props: {
    modelValue: Boolean,
    containers: { type: Array as PropType<UpdateContainer[]>, required: true },
    container: {
      type: Object as PropType<UpdateContainer>,
      default: undefined,
    },
    schedule: { type: Object as PropType<UpdateSchedule>, default: undefined },
  },
  emits: ["update:modelValue", "saved"],
  data: () => ({
    name: "",
    containerId: "",
    scope: "container" as UpdateScope,
    triggerId: "",
    preset: "daily",
    time: "03:00",
    weekday: "0",
    customCron: "0 3 * * *",
    timezone: "Europe/London",
    enabled: true,
    loading: false,
    saving: false,
    error: "",
    options: { triggers: [], stacks: [] } as UpdateOptions,
    presets: [
      { label: "Every day", value: "daily" },
      { label: "Every week", value: "weekly" },
      { label: "Custom cron", value: "custom" },
    ],
    weekdays: [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ].map((label, value) => ({ label, value: String(value) })),
  }),
  computed: {
    containerOptions() {
      return this.containers.map((container) => ({
        ...container,
        label: `${container.displayName || container.name || container.id} (${container.watcher || "unknown watcher"})`,
      }));
    },
    targetContainer(): UpdateContainer | undefined {
      return (
        this.containers.find(
          (container) => container.id === this.containerId,
        ) ||
        this.containers.find((container) => {
          const target = this.schedule?.target;
          if (!target || container.watcher !== target.watcher) return false;
          if (target.composeProject && target.composeService)
            return (
              container.labels?.["com.docker.compose.project"] ===
                target.composeProject &&
              container.labels?.["com.docker.compose.service"] ===
                target.composeService
            );
          return container.name === target.name;
        })
      );
    },
    stackReason(): string | undefined {
      return this.targetContainer
        ? stackAvailability([this.targetContainer], this.options)
        : "The target container is not currently available.";
    },
    scopeOptions() {
      return [
        { label: "This container only", value: "container" },
        {
          label: "Entire Compose stack",
          value: "stack",
          props: { disabled: Boolean(this.stackReason) },
        },
      ];
    },
    triggerOptions() {
      return this.options.triggers
        .filter(
          (trigger) =>
            this.scope !== "stack" || trigger.type === "dockercompose",
        )
        .map((trigger) => ({
          ...trigger,
          label: `${trigger.type} (${trigger.name})${trigger.dryrun ? " — dry run" : ""}`,
        }));
    },
    selectedTrigger() {
      return this.options.triggers.find(
        (trigger) => trigger.id === this.triggerId,
      );
    },
    cron(): string {
      if (this.preset === "custom") return this.customCron.trim();
      const [hour, minute] = this.time.split(":").map(Number);
      return `${minute} ${hour} * * ${this.preset === "weekly" ? this.weekday : "*"}`;
    },
    valid(): boolean {
      let validTimezone = true;
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: this.timezone });
      } catch {
        validTimezone = false;
      }
      return Boolean(
        this.name.trim() &&
        (this.schedule || this.containerId) &&
        this.triggerOptions.some((trigger) => trigger.id === this.triggerId) &&
        this.cron.split(/\s+/).length === 5 &&
        validTimezone &&
        (this.preset === "custom" || /^\d{2}:\d{2}$/.test(this.time)) &&
        (this.scope !== "stack" || !this.stackReason),
      );
    },
  },
  watch: {
    modelValue(value) {
      if (value) this.load();
    },
    scope() {
      if (this.loading) return;
      if (!this.triggerOptions.some((trigger) => trigger.id === this.triggerId))
        this.triggerId = this.triggerOptions[0]?.id || "";
    },
  },
  mounted() {
    if (this.modelValue) this.load();
  },
  methods: {
    close() {
      if (!this.saving) this.$emit("update:modelValue", false);
    },
    async load() {
      this.loading = true;
      this.error = "";
      this.name =
        this.schedule?.name ||
        `Update ${this.container?.displayName || this.container?.name || "containers"}`;
      this.containerId = this.container?.id || "";
      this.scope = this.schedule?.scope || "container";
      this.triggerId = this.schedule?.triggerId || "";
      this.preset = this.schedule ? "custom" : "daily";
      this.customCron = this.schedule?.cron || "0 3 * * *";
      this.time = "03:00";
      this.weekday = "0";
      this.timezone = this.schedule?.timezone || "Europe/London";
      this.enabled = this.schedule?.enabled ?? true;
      try {
        this.options = await getUpdateOptions();
        if (!this.triggerId) this.triggerId = this.triggerOptions[0]?.id || "";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
      }
    },
    async save() {
      if (!this.valid || this.saving) return;
      this.saving = true;
      this.error = "";
      const body = {
        name: this.name.trim(),
        ...(this.schedule ? {} : { containerId: this.containerId }),
        scope: this.scope,
        triggerId: this.triggerId,
        cron: this.cron,
        timezone: this.timezone,
        enabled: this.enabled,
      };
      try {
        if (this.schedule) await updateSchedule(this.schedule.id, body);
        else await createSchedule(body);
        this.$emit("saved");
        this.$emit("update:modelValue", false);
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },
  },
});
</script>
