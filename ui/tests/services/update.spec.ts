import {
  createSchedule,
  deleteSchedule,
  getUpdateOptions,
  listSchedules,
  runSchedule,
  runUpdates,
  stackAvailability,
  updateSchedule,
} from "@/services/update";
describe("update management API", () => {
  beforeEach(() => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      });
  });
  it("authenticates every request and encodes schedule IDs", async () => {
    await getUpdateOptions();
    await listSchedules();
    await createSchedule({
      name: "Nightly",
      containerId: "web",
      scope: "stack",
      triggerId: "compose.local",
      cron: "0 3 * * *",
      timezone: "Europe/London",
      enabled: true,
    });
    await updateSchedule("a/b", { enabled: false });
    await runSchedule("a/b");
    await deleteSchedule("a/b");
    const calls = (fetch as jest.Mock).mock.calls;
    expect(calls.map(([path]) => path)).toEqual([
      "/api/updates/options",
      "/api/schedules",
      "/api/schedules",
      "/api/schedules/a%2Fb",
      "/api/schedules/a%2Fb/run",
      "/api/schedules/a%2Fb",
    ]);
    expect(
      calls.every(([, options]) => options.credentials === "include"),
    ).toBe(true);
    expect(JSON.parse(calls[3][1].body)).toEqual({ enabled: false });
    expect(calls[4][1].headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(calls[4][1].body)).toEqual({});
  });
  it("submits bulk scope and selected IDs", async () => {
    const body = {
      containerIds: ["web", "db"],
      triggerId: "compose.local",
      scope: "stack" as const,
    };
    await runUpdates(body);
    expect(fetch).toHaveBeenCalledWith(
      "/api/updates/run",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
  });
  it("handles no-content deletion", async () => {
    (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 204 });
    expect(await deleteSchedule("one")).toBeUndefined();
  });
  it("reports server errors and non-JSON responses", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Unavailable stack" }),
    });
    await expect(getUpdateOptions()).rejects.toThrow("Unavailable stack");
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      statusText: "Forbidden",
      json: async () => {
        throw new Error();
      },
    });
    await expect(listSchedules()).rejects.toThrow("Forbidden");
  });
  it("requires server-confirmed stack availability", () => {
    const containers = [{ id: "web", name: "web", stack: "app" }];
    expect(
      stackAvailability(containers, { triggers: [], stacks: [] }),
    ).toContain("No Compose stack");
    const stack = {
      id: "app",
      name: "app",
      watcher: "local",
      containerIds: ["web"],
      composeFiles: ["/compose.yml"],
      available: false,
      reason: "File not mounted",
    };
    expect(
      stackAvailability(containers, { triggers: [], stacks: [stack] }),
    ).toBe("File not mounted");
    expect(
      stackAvailability(containers, {
        triggers: [],
        stacks: [{ ...stack, available: true }],
      }),
    ).toBeUndefined();
  });
});
