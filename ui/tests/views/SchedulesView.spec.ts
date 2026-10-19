import { shallowMount, flushPromises } from "@vue/test-utils";
import SchedulesView from "@/views/SchedulesView.vue";
import { getUser } from "@/services/auth";
import { getAllContainers } from "@/services/container";
import {
  deleteSchedule,
  listSchedules,
  runSchedule,
  updateSchedule,
} from "@/services/update";
jest.mock("@/services/auth", () => ({ getUser: jest.fn() }));
jest.mock("@/services/container", () => ({ getAllContainers: jest.fn() }));
jest.mock("@/services/update", () => ({
  deleteSchedule: jest.fn(),
  listSchedules: jest.fn(),
  runSchedule: jest.fn(),
  updateSchedule: jest.fn(),
}));
const schedule = {
  id: "nightly",
  name: "Nightly web",
  target: { name: "web", watcher: "local" },
  enabled: true,
  timezone: "Europe/London",
};
describe("SchedulesView", () => {
  beforeEach(() => {
    (getUser as jest.Mock).mockResolvedValue({ role: "admin" });
    (getAllContainers as jest.Mock).mockResolvedValue([{ id: "web" }]);
    (listSchedules as jest.Mock).mockResolvedValue([schedule]);
    (updateSchedule as jest.Mock).mockResolvedValue({});
    (deleteSchedule as jest.Mock).mockResolvedValue(undefined);
    (runSchedule as jest.Mock).mockResolvedValue({
      results: [{ id: "web", name: "web", status: "updated" }],
    });
  });
  it("loads schedules and container choices and opens create/edit dialogs", async () => {
    const wrapper = shallowMount(SchedulesView);
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.schedules).toEqual([schedule]);
    expect(vm.canWrite).toBe(true);
    vm.edit(schedule);
    expect(vm.selectedSchedule).toEqual(schedule);
    expect(vm.dialog).toBe(true);
    vm.edit();
    expect(vm.selectedSchedule).toBeUndefined();
  });
  it("pauses, resumes, runs and deletes schedules through authenticated APIs", async () => {
    const wrapper = shallowMount(SchedulesView);
    await flushPromises();
    const vm = wrapper.vm as any;
    await vm.toggle(schedule);
    expect(updateSchedule).toHaveBeenCalledWith("nightly", { enabled: false });
    await vm.toggle({ ...schedule, enabled: false });
    expect(updateSchedule).toHaveBeenCalledWith("nightly", { enabled: true });
    vm.runTarget = schedule;
    await vm.run();
    expect(runSchedule).toHaveBeenCalledWith("nightly");
    expect(vm.results[0].status).toBe("updated");
    expect(vm.showResults).toBe(true);
    vm.deleteTarget = schedule;
    await vm.remove();
    expect(deleteSchedule).toHaveBeenCalledWith("nightly");
    expect(vm.deleteTarget).toBeUndefined();
  });
  it("blocks read-only actions and controls", async () => {
    (getUser as jest.Mock).mockResolvedValue({ role: "ro" });
    const wrapper = shallowMount(SchedulesView);
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.canWrite).toBe(false);
    await vm.toggle(schedule);
    vm.runTarget = schedule;
    await vm.run();
    vm.deleteTarget = schedule;
    await vm.remove();
    expect(updateSchedule).not.toHaveBeenCalled();
    expect(runSchedule).not.toHaveBeenCalled();
    expect(deleteSchedule).not.toHaveBeenCalled();
  });
  it("renders requested timezone and handles malformed dates", async () => {
    const wrapper = shallowMount(SchedulesView);
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.formatDate("2026-07-01T02:00:00Z", "Europe/London")).toContain(
      "03:00",
    );
    expect(vm.formatDate(undefined)).toBe("—");
    expect(vm.formatDate("invalid")).toBe("invalid");
  });
  it("displays failures and releases pending actions", async () => {
    const wrapper = shallowMount(SchedulesView);
    await flushPromises();
    const vm = wrapper.vm as any;
    (updateSchedule as jest.Mock).mockRejectedValue(new Error("Toggle failed"));
    await vm.toggle(schedule);
    expect(vm.error).toBe("Toggle failed");
    expect(vm.busyId).toBe("");
    (runSchedule as jest.Mock).mockRejectedValue(new Error("Run failed"));
    vm.runTarget = schedule;
    await vm.run();
    expect(vm.error).toBe("Run failed");
    (deleteSchedule as jest.Mock).mockRejectedValue(new Error("Delete failed"));
    vm.deleteTarget = schedule;
    await vm.remove();
    expect(vm.error).toBe("Delete failed");
    (listSchedules as jest.Mock).mockRejectedValue(new Error("Offline"));
    await vm.load();
    expect(vm.error).toBe("Offline");
    expect(vm.loading).toBe(false);
  });
});
