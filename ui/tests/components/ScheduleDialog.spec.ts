import { shallowMount, flushPromises } from "@vue/test-utils";
import ScheduleDialog from "@/components/ScheduleDialog.vue";
import {
  createSchedule,
  getUpdateOptions,
  updateSchedule,
} from "@/services/update";
jest.mock("@/services/update", () => ({
  ...jest.requireActual("@/services/update"),
  createSchedule: jest.fn(),
  getUpdateOptions: jest.fn(),
  updateSchedule: jest.fn(),
}));
const container = { id: "web", name: "web", watcher: "local" };
const options = {
  triggers: [
    {
      id: "compose.local",
      type: "dockercompose",
      name: "local",
      dryrun: false,
    },
  ],
  stacks: [
    {
      id: "app",
      name: "app",
      watcher: "local",
      containerIds: ["web"],
      composeFiles: ["/compose.yml"],
      available: true,
    },
  ],
};
const mountDialog = (schedule?: object) =>
  shallowMount(ScheduleDialog, {
    props: { modelValue: true, containers: [container], container, schedule },
  });
describe("ScheduleDialog", () => {
  beforeEach(() => {
    (getUpdateOptions as jest.Mock).mockResolvedValue(options);
    (createSchedule as jest.Mock).mockResolvedValue({});
    (updateSchedule as jest.Mock).mockResolvedValue({});
  });
  it("defaults to daily 03:00 Europe/London and creates selected target", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.timezone).toBe("Europe/London");
    expect(vm.cron).toBe("0 3 * * *");
    await vm.save();
    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: "web",
        cron: "0 3 * * *",
        timezone: "Europe/London",
        enabled: true,
      }),
    );
    expect(wrapper.emitted("saved")).toHaveLength(1);
  });
  it("supports weekly/custom cron and rejects invalid timezone", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.preset = "weekly";
    vm.time = "04:30";
    vm.weekday = "2";
    expect(vm.cron).toBe("30 4 * * 2");
    vm.preset = "custom";
    vm.customCron = "0 2 * * 1-5";
    expect(vm.cron).toBe("0 2 * * 1-5");
    vm.timezone = "Invalid/Timezone";
    expect(vm.valid).toBe(false);
    await vm.save();
    expect(createSchedule).not.toHaveBeenCalled();
  });
  it("edits stable target without requiring transient container ID", async () => {
    const wrapper = mountDialog({
      id: "one",
      name: "Nightly",
      target: { name: "web", watcher: "local" },
      scope: "stack",
      triggerId: "compose.local",
      cron: "0 4 * * *",
      timezone: "Europe/London",
      enabled: false,
    });
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.targetContainer.id).toBe("web");
    await vm.save();
    expect(updateSchedule).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({
        scope: "stack",
        enabled: false,
        cron: "0 4 * * *",
      }),
    );
    expect(updateSchedule).toHaveBeenCalledWith(
      "one",
      expect.not.objectContaining({ containerId: expect.anything() }),
    );
  });
  it("retains save failures in open dialog", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    (createSchedule as jest.Mock).mockRejectedValue(new Error("Bad cron"));
    await (wrapper.vm as any).save();
    expect((wrapper.vm as any).error).toBe("Bad cron");
    expect(wrapper.emitted("saved")).toBeUndefined();
    expect((wrapper.vm as any).saving).toBe(false);
  });
  it("reports loading failure and prevents closing while saving", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.saving = true;
    vm.close();
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    vm.saving = false;
    (getUpdateOptions as jest.Mock).mockRejectedValue(new Error("Offline"));
    await vm.load();
    expect(vm.error).toBe("Offline");
    vm.close();
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
  });
  it("retains a saved nondefault trigger when loading a stack schedule", async () => {
    (getUpdateOptions as jest.Mock).mockResolvedValue({
      ...options,
      triggers: [
        ...options.triggers,
        {
          id: "compose.second",
          type: "dockercompose",
          name: "second",
          dryrun: false,
        },
      ],
    });
    const wrapper = mountDialog({
      id: "one",
      name: "Nightly",
      target: { name: "web", watcher: "local" },
      scope: "stack",
      triggerId: "compose.second",
      cron: "0 4 * * *",
      timezone: "Europe/London",
      enabled: true,
    });
    await flushPromises();
    expect((wrapper.vm as any).triggerId).toBe("compose.second");
  });
  it("resolves stable Compose labels after the container name changes", async () => {
    const wrapper = shallowMount(ScheduleDialog, {
      props: {
        modelValue: true,
        containers: [
          {
            id: "new-id",
            name: "renamed-web",
            watcher: "local",
            labels: {
              "com.docker.compose.project": "app",
              "com.docker.compose.service": "web",
            },
          },
        ],
        schedule: {
          id: "one",
          name: "Nightly",
          target: {
            name: "old-web",
            watcher: "local",
            composeProject: "app",
            composeService: "web",
          },
          scope: "container",
          triggerId: "compose.local",
          cron: "0 4 * * *",
          timezone: "Europe/London",
          enabled: true,
        },
      },
    });
    await flushPromises();
    expect((wrapper.vm as any).targetContainer.id).toBe("new-id");
  });
});
