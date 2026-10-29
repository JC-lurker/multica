// Per-issue agent control state: shows the "agent controlling" indicator and
// lets the user pause (take over). No electron imports so it is unit-testable.

export type AgentStatus = "idle" | "active" | "paused";

/** Indicator stays lit this long after the last agent action. */
export const ACTIVE_LINGER_MS = 8_000;

const paused = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<(issue: string, status: AgentStatus) => void>();

export function agentStatus(issue: string): AgentStatus {
  if (paused.has(issue)) return "paused";
  return timers.has(issue) ? "active" : "idle";
}

function emit(issue: string) {
  for (const l of listeners) l(issue, agentStatus(issue));
}

export function onAgentStatus(cb: (issue: string, status: AgentStatus) => void): void {
  listeners.add(cb);
}

export function setAgentPaused(issue: string, value: boolean): void {
  if (value) paused.add(issue);
  else paused.delete(issue);
  emit(issue);
}

/** Called at the start of every agent action; throws if the user has taken over. */
export function beginAgentAction(issue: string, onPaused: () => Error): void {
  if (paused.has(issue)) throw onPaused();
  const had = timers.has(issue);
  clearTimeout(timers.get(issue));
  timers.set(
    issue,
    setTimeout(() => {
      timers.delete(issue);
      emit(issue);
    }, ACTIVE_LINGER_MS),
  );
  if (!had) emit(issue);
}

/** Re-check mid-action (long waits) so a take-over stops the agent promptly. */
export function assertNotPaused(issue: string, onPaused: () => Error): void {
  if (paused.has(issue)) throw onPaused();
}
