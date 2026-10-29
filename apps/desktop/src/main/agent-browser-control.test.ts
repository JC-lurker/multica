// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_LINGER_MS,
  agentStatus,
  beginAgentAction,
  onAgentStatus,
  setAgentPaused,
} from "./agent-browser-control";

const boom = () => new Error("paused");

describe("agent control state", () => {
  afterEach(() => {
    setAgentPaused("i", false);
    vi.useRealTimers();
  });

  it("goes active on action, idle after linger, emits changes", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    onAgentStatus((_i, s) => seen.push(s));
    beginAgentAction("i", boom);
    expect(agentStatus("i")).toBe("active");
    vi.advanceTimersByTime(ACTIVE_LINGER_MS);
    expect(agentStatus("i")).toBe("idle");
    expect(seen).toEqual(["active", "idle"]);
  });

  it("blocks actions while paused and resumes", () => {
    setAgentPaused("i", true);
    expect(agentStatus("i")).toBe("paused");
    expect(() => beginAgentAction("i", boom)).toThrow("paused");
    setAgentPaused("i", false);
    expect(() => beginAgentAction("i", boom)).not.toThrow();
  });
});
