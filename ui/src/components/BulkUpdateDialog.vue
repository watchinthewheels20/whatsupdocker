<template>
  <v-dialog
    :model-value="modelValue"
    max-width="680"
    :persistent="busy"
    @update:model-value="close"
  >
    <v-card rounded="lg">
      <v-card-title class="pt-5">Update selected containers</v-card-title>
      <v-card-text>
        <v-progress-linear
          v-if="loading"
          indeterminate
          aria-label="Loading update options"
        />
        <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{
          error
        }}</v-alert>
        <p class="mb-3">
          {{ containers.length }} containers selected. Services may restart
          during updates.
        </p>
        <v-list density="compact" aria-label="Selected containers" class="mb-3">
          <v-list-item
            v-for="container in containers"
            :key="container.id"
            :title="container.displayName || container.name || container.id"
            :subtitle="`${container.watcher || ''} · ${container.image?.tag?.value || 'Current image'} → ${container.updateKind?.remoteValue || container.result?.tag || container.result?.digest || 'Check for updates'}`"
          />
        </v-list>
        <v-radio-group
          v-model="scope"
          :disabled="busy || results.length > 0"
          label="Update scope"
        >
          <v-radio label="Selected containers only" value="container" />
          <v-radio
            label="Entire Compose stacks"
            value="stack"
            :disabled="Boolean(stackReason)"
          />
        </v-radio-group>
        <v-alert
          v-if="scope === 'stack'"
          type="info"
          variant="tonal"
          class="mb-4"
        >
          Every service in {{ affectedStacks.length }} Compose stack(s) will be
          pulled and recreated as needed, including services outside your
          selection. Each stack runs once.
          <div v-for="stack in affectedStacks" :key="stack.id" class="mt-3">
            <strong>{{ stack.name }} ({{ stack.watcher }})</strong>
            <div class="text-caption">
              Watched containers:
              {{ stack.containerIds.map(containerName).join(", ") }}
            </div>
            <div class="text-caption">
              Compose files: {{ stack.composeFiles.join(", ") }}
            </div>
            <div class="text-caption">
              All services defined in these files are included, even if not
              watched here.
            </div>
          </div>
        </v-alert>
        <p v-if="stackReason" class="text-caption mb-3">
          Whole-stack update unavailable: {{ stackReason }}
        </p>
        <v-select
          v-model="triggerId"
          :items="triggers"
          item-title="label"
          item-value="id"
          label="Update trigger"
          variant="outlined"
          :disabled="busy || results.length > 0"
        />
        <v-alert
          v-if="!loading && !triggers.length"
          type="warning"
          variant="tonal"
          >No compatible update trigger is configured.</v-alert
        >
        <v-alert
          v-if="selectedTrigger?.dryrun"
          type="warning"
          variant="tonal"
          class="mb-3"
          >This trigger uses dry run mode. Containers will not be
          changed.</v-alert
        >
        <v-list v-if="results.length" aria-label="Update results">
          <v-list-item
            v-for="(result, index) in results"
            :key="`${result.id}-${index}`"
            :title="`${result.name}: ${result.status}`"
            :subtitle="result.message"
            :prepend-icon="
              result.status === 'failed'
                ? 'mdi-alert-circle-outline'
                : result.status === 'updated'
                  ? 'mdi-check-circle-outline'
                  : 'mdi-minus-circle-outline'
            "
          />
        </v-list>
      </v-card-text>
      <v-card-actions class="pa-4 justify-end">
        <v-btn :disabled="busy" @click="close">{{
          results.length ? "Close" : "Cancel"
        }}</v-btn>
        <v-btn
          v-if="!results.length"
          color="primary"
          variant="flat"
          :loading="busy"
          :disabled="
            loading ||
            !triggerId ||
            !containers.length ||
            (scope === 'stack' && Boolean(stackReason))
          "
          @click="execute"
          >Update {{ scope === "stack" ? "stacks" : "containers" }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
<script lang="ts">
import { defineComponent, PropType } from "vue";
import {
  getUpdateOptions,
  runUpdates,
  stackAvailability,
  UpdateContainer,
  UpdateOptions,
  UpdateResult,
  UpdateScope,
} from "@/services/update";
export default defineComponent({
  props: {
    modelValue: Boolean,
    allContainers: {
      type: Array as PropType<UpdateContainer[]>,
      default: () => [],
    },
    containers: { type: Array as PropType<UpdateContainer[]>, required: true },
    initialScope: {
      type: String as PropType<UpdateScope>,
      default: "container",
    },
  },
  emits: ["update:modelValue", "updated"],
  data: () => ({
    options: { triggers: [], stacks: [] } as UpdateOptions,
    scope: "container" as UpdateScope,
    triggerId: "",
    loading: false,
    busy: false,
    error: "",
    results: [] as UpdateResult[],
  }),
  computed: {
    stackReason(): string | undefined {
      return stackAvailability(this.containers, this.options);
    },
    affectedStacks() {
      return this.options.stacks.filter((stack) =>
        this.containers.some((container) =>
          stack.containerIds.includes(container.id),
        ),
      );
    },
    triggers() {
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
  },
  watch: {
    modelValue(value) {
      if (value) this.load();
    },
    scope() {
      this.triggerId = this.triggers[0]?.id || "";
    },
  },
  mounted() {
    if (this.modelValue) this.load();
  },
  methods: {
    containerName(id: string) {
      const container =
        this.allContainers.find((item) => item.id === id) ||
        this.containers.find((item) => item.id === id);
      return container?.displayName || container?.name || id;
    },
    close() {
      if (!this.busy) this.$emit("update:modelValue", false);
    },
    async load() {
      this.loading = true;
      this.error = "";
      this.results = [];
      this.scope = this.initialScope;
      try {
        this.options = await getUpdateOptions();
        this.triggerId = this.triggers[0]?.id || "";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.triggerId = "";
      } finally {
        this.loading = false;
      }
    },
    async execute() {
      if (
        !this.triggerId ||
        this.busy ||
        (this.scope === "stack" && this.stackReason)
      )
        return;
      this.busy = true;
      this.error = "";
      try {
        this.results = (
          await runUpdates({
            containerIds: this.containers.map((container) => container.id),
            triggerId: this.triggerId,
            scope: this.scope,
          })
        ).results;
        this.$emit("updated");
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.busy = false;
      }
    },
  },
});
</script>
