import { shallowMount, flushPromises } from "@vue/test-utils";
import BulkUpdateDialog from "@/components/BulkUpdateDialog.vue";
import { getUpdateOptions, runUpdates } from "@/services/update";
jest.mock("@/services/update", () => ({
  ...jest.requireActual("@/services/update"),
  getUpdateOptions: jest.fn(),
  runUpdates: jest.fn(),
}));
const options = {
  triggers: [
    { id: "docker.local", type: "docker", name: "local", dryrun: false },
    { id: "compose.local", type: "dockercompose", name: "local", dryrun: true },
  ],
  stacks: [
    {
      id: "app",
      name: "app",
      watcher: "local",
      containerIds: ["web", "db"],
      composeFiles: ["/compose.yml"],
      available: true,
    },
  ],
};
const mountDialog = () =>
  shallowMount(BulkUpdateDialog, {
    props: { modelValue: true, containers: [{ id: "web" }, { id: "db" }] },
  });
describe("BulkUpdateDialog", () => {
  beforeEach(() => {
    (getUpdateOptions as jest.Mock).mockResolvedValue(
      JSON.parse(JSON.stringify(options)),
    );
    (runUpdates as jest.Mock).mockResolvedValue({
      results: [{ id: "app", name: "app", status: "updated" }],
    });
  });
  it("filters stack triggers and previews each stack once", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.scope = "stack";
    await wrapper.vm.$nextTick();
    expect(vm.triggers.map((trigger: { id: string }) => trigger.id)).toEqual([
      "compose.local",
    ]);
    expect(vm.affectedStacks).toHaveLength(1);
    expect(vm.selectedTrigger.dryrun).toBe(true);
  });
  it("runs requested scope and retains per-target results", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.scope = "stack";
    await wrapper.vm.$nextTick();
    await vm.execute();
    expect(runUpdates).toHaveBeenCalledWith({
      containerIds: ["web", "db"],
      triggerId: "compose.local",
      scope: "stack",
    });
    expect(vm.results[0].status).toBe("updated");
    expect(wrapper.emitted("updated")).toHaveLength(1);
  });
  it("blocks unavailable stacks and displays operation errors", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.options.stacks = [];
    vm.scope = "stack";
    await wrapper.vm.$nextTick();
    await vm.execute();
    expect(runUpdates).not.toHaveBeenCalled();
    vm.scope = "container";
    await wrapper.vm.$nextTick();
    (runUpdates as jest.Mock).mockRejectedValue(new Error("Update failed"));
    await vm.execute();
    expect(vm.error).toBe("Update failed");
    expect(vm.busy).toBe(false);
  });
  it("prevents closing during update and handles option failure", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.busy = true;
    vm.close();
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    vm.busy = false;
    vm.close();
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
    (getUpdateOptions as jest.Mock).mockRejectedValue(new Error("Cannot load"));
    await vm.load();
    expect(vm.error).toBe("Cannot load");
    expect(vm.triggerId).toBe("");
  });
});
