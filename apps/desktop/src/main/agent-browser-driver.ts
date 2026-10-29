import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WebContents } from "electron";
import {
  type AxNode,
  type BrowserDriver,
  BridgeError,
  NO_BROWSER_MESSAGE,
  RefTable,
  STALE_REF_MESSAGE,
  diffSnapshot,
  formatSnapshot,
  startBridgeServer,
} from "./agent-browser-bridge";
import { captureIssueBrowserJpeg, getIssueBrowserState, getIssueBrowserWebContents, navigateIssueBrowser } from "./issue-browser";

/** Where the CLI discovers the bridge; mirrors `bridgeFilePath` in the Go CLI. */
export function bridgeFilePath(): string {
  return join(homedir(), ".multica", "browser-bridge.json");
}

const refTables = new WeakMap<WebContents, RefTable>();

function refsFor(wc: WebContents): RefTable {
  let refs = refTables.get(wc);
  if (!refs) {
    const table = new RefTable();
    refs = table;
    refTables.set(wc, table);
    // Refs point at DOM nodes of one document; a new document invalidates them all.
    wc.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) table.clear();
    });
  }
  return refs;
}

function target(issue: string): { wc: WebContents; refs: RefTable } {
  const wc = getIssueBrowserWebContents(issue);
  if (!wc) throw new BridgeError(404, NO_BROWSER_MESSAGE);
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  return { wc, refs: refsFor(wc) };
}

const PICKED_REF = "@picked";
const NO_PICK_MESSAGE =
  "no picked element; ask the user to use the picker in the Browser panel (it re-resolves after navigation)";

/** `@picked` is the element the user last picked; the pick script stashes it on the page. */
async function resolvePicked(wc: WebContents): Promise<number> {
  const evaluated = (await wc.debugger.sendCommand("Runtime.evaluate", {
    expression: "window.__multicaPicked",
  })) as { result: { objectId?: string; subtype?: string } };
  if (evaluated.result.subtype !== "node" || !evaluated.result.objectId) {
    throw new BridgeError(409, NO_PICK_MESSAGE);
  }
  const { node } = (await wc.debugger.sendCommand("DOM.describeNode", {
    objectId: evaluated.result.objectId,
  })) as { node: { backendNodeId: number } };
  return node.backendNodeId;
}

async function withNode<T>(wc: WebContents, refs: RefTable, ref: string, run: (backendNodeId: number) => Promise<T>) {
  const backendNodeId = ref === PICKED_REF ? await resolvePicked(wc) : refs.resolve(ref);
  try {
    return await run(backendNodeId);
  } catch (err) {
    // CDP rejects removed nodes; report that as a stale ref instead of a raw protocol error.
    if (err instanceof Error && /No node|Could not find node|does not belong/i.test(err.message)) {
      throw new BridgeError(409, STALE_REF_MESSAGE);
    }
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function axNodes(wc: WebContents): Promise<AxNode[]> {
  const tree = (await wc.debugger.sendCommand("Accessibility.getFullAXTree")) as { nodes: AxNode[] };
  return tree.nodes;
}

/** Run an action, let the page settle, and report what changed (small by design). */
async function withDiff(wc: WebContents, refs: RefTable, act: () => Promise<void>): Promise<string> {
  const before = { url: wc.getURL(), title: wc.getTitle() };
  await act();
  await sleep(150);
  for (let i = 0; i < 25 && wc.isLoading(); i++) await sleep(100);
  const lines: string[] = [];
  if (wc.getURL() !== before.url) lines.push(`url: ${wc.getURL()}`);
  if (wc.getTitle() !== before.title) lines.push(`title: ${wc.getTitle()}`);
  if (refs.known) lines.push(...diffSnapshot(await axNodes(wc), refs));
  else lines.push("refs reset (new page); run `multica browser snapshot`");
  return lines.length ? lines.join("\n") : "no changes";
}

const driver: BrowserDriver = {
  async snapshot(issue, scope) {
    const { wc, refs } = target(issue);
    const scopeId = scope ? await withNode(wc, refs, scope, async (id) => id) : undefined;
    const body = formatSnapshot(await axNodes(wc), refs, { scope: scopeId });
    return `page: ${wc.getTitle()} ${wc.getURL()}\n${body}`;
  },

  async click(issue, ref) {
    const { wc, refs } = target(issue);
    return withDiff(wc, refs, () =>
      withNode(wc, refs, ref, async (backendNodeId) => {
        await wc.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId });
        const { model } = (await wc.debugger.sendCommand("DOM.getBoxModel", { backendNodeId })) as {
          model: { content: number[] };
        };
        const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
        const x = (x1 + x3) / 2;
        const y = (y1 + y3) / 2;
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
          await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            button: type === "mouseMoved" ? "none" : "left",
            clickCount: type === "mouseMoved" ? 0 : 1,
          });
        }
      }),
    );
  },

  async type(issue, ref, text, opts) {
    const { wc, refs } = target(issue);
    return withDiff(wc, refs, () =>
      withNode(wc, refs, ref, async (backendNodeId) => {
        await wc.debugger.sendCommand("DOM.focus", { backendNodeId });
        if (opts.clear) {
          const { object } = (await wc.debugger.sendCommand("DOM.resolveNode", { backendNodeId })) as {
            object: { objectId: string };
          };
          await wc.debugger.sendCommand("Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: "function(){ if (this.select) this.select(); }",
          });
        }
        if (text) await wc.debugger.sendCommand("Input.insertText", { text });
        if (opts.submit) {
          for (const type of ["keyDown", "keyUp"] as const) {
            await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
              type,
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              ...(type === "keyDown" ? { text: "\r" } : {}),
            });
          }
        }
      }),
    );
  },

  async goto(issue, url) {
    const { wc, refs } = target(issue);
    return withDiff(wc, refs, async () => {
      if (!navigateIssueBrowser(issue, url)) throw new BridgeError(400, "only http(s) URLs are allowed");
    });
  },

  async wait(issue, { text, url, timeoutMs }) {
    const { wc, refs } = target(issue);
    const deadline = Date.now() + timeoutMs;
    const expression = text ? `!!document.body && document.body.innerText.includes(${JSON.stringify(text)})` : "";
    for (;;) {
      const met = text
        ? ((await wc.debugger.sendCommand("Runtime.evaluate", { expression })) as { result: { value?: unknown } })
            .result.value === true
        : wc.getURL().includes(url ?? "");
      if (met) break;
      if (Date.now() >= deadline) {
        throw new BridgeError(408, `timed out after ${timeoutMs}ms waiting for ${text ? "text" : "url"}`);
      }
      await sleep(200);
    }
    return withDiff(wc, refs, async () => {});
  },

  async shot(issue, ref) {
    const { wc, refs } = target(issue);
    let rect: { x: number; y: number; width: number; height: number } | undefined;
    if (ref) {
      rect = await withNode(wc, refs, ref, async (backendNodeId) => {
        await wc.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId });
        const { model } = (await wc.debugger.sendCommand("DOM.getBoxModel", { backendNodeId })) as {
          model: { content: number[] };
        };
        const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
        return { x: x1, y: y1, width: x3 - x1, height: y3 - y1 };
      });
    }
    const jpeg = await captureIssueBrowserJpeg(issue, rect);
    if (!jpeg) throw new BridgeError(404, NO_BROWSER_MESSAGE);
    return jpeg;
  },

  async state(issue) {
    const state = getIssueBrowserState(issue);
    if (!state) throw new BridgeError(404, NO_BROWSER_MESSAGE);
    return state;
  },
};

let stop: (() => void) | null = null;

/** Start the loopback bridge and publish its port/token for the CLI. */
export async function startAgentBrowserBridge(): Promise<void> {
  if (stop) return;
  const { port, token, server } = await startBridgeServer(driver);
  const file = bridgeFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  stop = () => {
    server.close();
    rmSync(file, { force: true });
  };
}

export function stopAgentBrowserBridge(): void {
  stop?.();
  stop = null;
}
