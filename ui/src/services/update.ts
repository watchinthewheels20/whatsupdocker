import { url } from "./base";

export type UpdateScope = "container" | "stack";
export interface UpdateTrigger {
  id: string;
  type: string;
  name: string;
  dryrun: boolean;
}
export interface UpdateStack {
  id: string;
  name: string;
  watcher: string;
  containerIds: string[];
  composeFiles: string[];
  available: boolean;
  reason?: string;
}
export interface UpdateOptions {
  triggers: UpdateTrigger[];
  stacks: UpdateStack[];
}
export interface UpdateContainer {
  id: string;
  name?: string;
  displayName?: string;
  watcher?: string;
  stack?: string;
  labels?: Record<string, string>;
  image?: { tag?: { value?: string } };
  updateKind?: { remoteValue?: string };
  result?: { tag?: string; digest?: string };
}
export interface UpdateResult {
  id: string;
  name: string;
  status: "updated" | "skipped" | "failed";
  message?: string;
}
export interface UpdateResponse {
  results: UpdateResult[];
}
export interface ScheduleInput {
  name: string;
  containerId?: string;
  triggerId: string;
  scope: UpdateScope;
  cron: string;
  timezone: string;
  enabled: boolean;
}
export interface UpdateSchedule extends Omit<ScheduleInput, "containerId"> {
  id: string;
  target: {
    watcher: string;
    name: string;
    composeProject?: string;
    composeService?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string | null;
  lastStatus?: "running" | "updated" | "skipped" | "failed" | null;
  lastError?: string | null;
  nextRunAt?: string | null;
}

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(url(`api/${path}`), {
    method,
    credentials: "include",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.message || error.error || response.statusText || "Request failed",
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const getUpdateOptions = (): Promise<UpdateOptions> =>
  request("updates/options");
export const runUpdates = (body: {
  containerIds: string[];
  triggerId: string;
  scope: UpdateScope;
}): Promise<UpdateResponse> => request("updates/run", "POST", body);
export const listSchedules = (): Promise<UpdateSchedule[]> =>
  request("schedules");
export const createSchedule = (body: ScheduleInput): Promise<UpdateSchedule> =>
  request("schedules", "POST", body);
export const updateSchedule = (
  id: string,
  body: Partial<ScheduleInput>,
): Promise<UpdateSchedule> =>
  request(`schedules/${encodeURIComponent(id)}`, "PUT", body);
export const deleteSchedule = (id: string): Promise<void> =>
  request(`schedules/${encodeURIComponent(id)}`, "DELETE");
export const runSchedule = (id: string): Promise<UpdateResponse> =>
  request(`schedules/${encodeURIComponent(id)}/run`, "POST", {});

export function stackAvailability(
  containers: UpdateContainer[],
  options: UpdateOptions,
): string | undefined {
  for (const container of containers) {
    const stack = options.stacks.find((item) =>
      item.containerIds.includes(container.id),
    );
    if (!stack)
      return `No Compose stack is available for ${container.displayName || container.name || container.id}.`;
    if (!stack.available)
      return stack.reason || `Compose stack ${stack.name} is unavailable.`;
  }
  return undefined;
}
