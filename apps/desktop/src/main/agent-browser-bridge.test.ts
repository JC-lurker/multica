// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserDriver,
  type RunningBridge,
  BridgeError,
  RefTable,
  formatSnapshot,
  startBridgeServer,
} from "./agent-browser-bridge";

const node = (role: string, name: string, id: number, extra: object = {}) => ({
  role: { value: role },
  name: { value: name },
  backendDOMNodeId: id,
  ...extra,
});

describe("formatSnapshot / RefTable", () => {
  it("lists only interactive nodes with sequential refs", () => {
    const refs = new RefTable();
    const out = formatSnapshot(
      [
        node("heading", "Title", 1),
        node("button", "Submit", 10),
        node("textbox", "Email", 11, { value: { value: "a@b.c" } }),
        node("link", "Hidden", 12, { ignored: true }),
        node("checkbox", "Agree", 13, { properties: [{ name: "checked", value: { value: true } }] }),
      ],
      refs,
    );
    expect(out.split("\n")).toEqual([
      '[@e1] button "Submit"',
      '[@e2] textbox "Email" value="a@b.c"',
      "[@e3] checkbox \"Agree\" checked",
    ]);
    expect(refs.resolve("@e2")).toBe(11);
  });

  it("re-snapshot restarts numbering and drops old refs", () => {
    const refs = new RefTable();
    formatSnapshot([node("button", "A", 1), node("button", "B", 2)], refs);
    formatSnapshot([node("button", "C", 3)], refs);
    expect(refs.resolve("@e1")).toBe(3);
    expect(() => refs.resolve("@e2")).toThrow(BridgeError);
  });

  it("clear (navigation) makes every ref stale", () => {
    const refs = new RefTable();
    formatSnapshot([node("button", "A", 1)], refs);
    refs.clear();
    expect(() => refs.resolve("@e1")).toThrowError(/stale ref/);
    try {
      refs.resolve("@e1");
    } catch (e) {
      expect((e as BridgeError).status).toBe(409);
    }
  });
});

describe("bridge server", () => {
  let bridge: RunningBridge | undefined;
  afterEach(() => bridge?.server.close());

  const driver = (): BrowserDriver => ({
    snapshot: vi.fn().mockResolvedValue("snap"),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    state: vi.fn().mockResolvedValue({ url: "https://x" }),
  });

  const call = (b: RunningBridge, path: string, body: object, token: string | null = b.token) =>
    fetch(`http://127.0.0.1:${b.port}${path}`, {
      method: "POST",
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("rejects missing or wrong tokens without touching the driver", async () => {
    const d = driver();
    bridge = await startBridgeServer(d, "secret");
    expect((await call(bridge, "/v1/snapshot", { issue: "i" }, null)).status).toBe(401);
    expect((await call(bridge, "/v1/snapshot", { issue: "i" }, "wrong")).status).toBe(401);
    expect(d.snapshot).not.toHaveBeenCalled();
  });

  it("dispatches authorized requests", async () => {
    const d = driver();
    bridge = await startBridgeServer(d, "secret");
    const res = await call(bridge, "/v1/snapshot", { issue: "i" });
    expect(await res.json()).toEqual({ ok: true, snapshot: "snap" });
    await call(bridge, "/v1/type", { issue: "i", ref: "@e1", text: "hi", submit: true });
    expect(d.type).toHaveBeenCalledWith("i", "@e1", "hi", { clear: false, submit: true });
  });

  it("surfaces driver errors with their status", async () => {
    const d = driver();
    d.click = vi.fn().mockRejectedValue(new BridgeError(409, "stale ref: x"));
    bridge = await startBridgeServer(d, "secret");
    const res = await call(bridge, "/v1/click", { issue: "i", ref: "@e9" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "stale ref: x" });
  });

  it("validates required fields", async () => {
    bridge = await startBridgeServer(driver(), "secret");
    expect((await call(bridge, "/v1/click", { issue: "i" })).status).toBe(400);
  });
});
