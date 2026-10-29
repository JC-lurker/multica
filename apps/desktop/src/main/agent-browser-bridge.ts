import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Failure with an HTTP status the CLI can show verbatim. */
export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const NO_BROWSER_MESSAGE =
  "no browser open for this issue; open the Browser panel on the issue in Multica desktop first";
export const STALE_REF_MESSAGE =
  "stale ref: the page changed since the snapshot; run `multica browser snapshot` again";

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "spinbutton",
  "listbox",
  "treeitem",
]);

export interface AxNode {
  nodeId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  backendDOMNodeId?: number;
}

/** Snapshot size cap; the rest is reachable with `--scope @eN`. */
export const SNAPSHOT_MAX_ELEMENTS = 300;
const DIFF_MAX_LINES = 20;

/** `@eN` refs for one page; cleared whenever the page navigates. */
export class RefTable {
  private byRef = new Map<string, number>();
  private byId = new Map<number, string>();
  private next = 1;
  /** Interactive elements as of the last snapshot/diff (null until a snapshot). */
  known: Map<number, string> | null = null;

  /** Stable per DOM node: asking twice returns the same ref. */
  refFor(backendNodeId: number): string {
    let ref = this.byId.get(backendNodeId);
    if (!ref) {
      ref = `@e${this.next++}`;
      this.byId.set(backendNodeId, ref);
      this.byRef.set(ref, backendNodeId);
    }
    return ref;
  }

  refOf(backendNodeId: number): string | undefined {
    return this.byId.get(backendNodeId);
  }

  resolve(ref: string): number {
    const id = this.byRef.get(ref);
    if (id === undefined) throw new BridgeError(409, STALE_REF_MESSAGE);
    return id;
  }

  clear(): void {
    this.byRef.clear();
    this.byId.clear();
    this.known = null;
    this.next = 1;
  }
}

/** Interactive AX nodes as `backendNodeId -> description`; `scope` limits to a subtree. */
export function describeNodes(nodes: AxNode[], scope?: number): Map<number, string> {
  let list = nodes;
  if (scope !== undefined) {
    const byNodeId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => n.backendDOMNodeId === scope);
    if (!root) throw new BridgeError(409, STALE_REF_MESSAGE);
    list = [];
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      list.push(n);
      for (const c of [...(n.childIds ?? [])].reverse()) {
        const child = byNodeId.get(c);
        if (child) stack.push(child);
      }
    }
  }
  const out = new Map<number, string>();
  for (const node of list) {
    const role = String(node.role?.value ?? "");
    if (node.ignored || !INTERACTIVE_ROLES.has(role) || node.backendDOMNodeId === undefined) continue;
    let line = role;
    const name = String(node.name?.value ?? "").trim();
    if (name) line += ` ${JSON.stringify(name)}`;
    const value = node.value?.value;
    if (value !== undefined && value !== "") line += ` value=${JSON.stringify(String(value))}`;
    for (const p of node.properties ?? []) {
      if (["checked", "disabled", "expanded", "selected"].includes(p.name) && p.value?.value !== false) {
        line += ` ${p.name}${p.value?.value === true ? "" : `=${String(p.value?.value)}`}`;
      }
    }
    out.set(node.backendDOMNodeId, line);
  }
  return out;
}

/**
 * Renders interactive AX nodes, one per line, assigning refs. A full snapshot
 * resets refs; a scoped one keeps them. Output is capped at `max` elements.
 */
export function formatSnapshot(
  nodes: AxNode[],
  refs: RefTable,
  opts: { scope?: number; max?: number } = {},
): string {
  const max = opts.max ?? SNAPSHOT_MAX_ELEMENTS;
  if (opts.scope === undefined) refs.clear();
  const found = describeNodes(nodes, opts.scope);
  refs.known = new Map([...(refs.known ?? []), ...found]);
  const lines = [...found].slice(0, max).map(([id, text]) => `[${refs.refFor(id)}] ${text}`);
  if (found.size > max) {
    lines.push(`... ${found.size - max} more elements not shown; narrow with \`--scope @eN\``);
  }
  return lines.join("\n");
}

/** Interactive elements added (+), changed (~) or removed (-) since the last snapshot/diff. */
export function diffSnapshot(nodes: AxNode[], refs: RefTable): string[] {
  const before = refs.known;
  if (!before) return [];
  const now = describeNodes(nodes);
  const out: string[] = [];
  for (const [id, text] of now) {
    const prev = before.get(id);
    if (prev !== text) out.push(`${prev === undefined ? "+" : "~"} [${refs.refFor(id)}] ${text}`);
  }
  for (const id of before.keys()) {
    const ref = refs.refOf(id);
    if (!now.has(id) && ref) out.push(`- [${ref}]`);
  }
  refs.known = now;
  if (out.length > DIFF_MAX_LINES) {
    return [...out.slice(0, DIFF_MAX_LINES), `... ${out.length - DIFF_MAX_LINES} more changes`];
  }
  return out;
}

export interface BrowserDriver {
  /** Actions resolve to a short diff (url/title and changed elements) for the CLI to print. */
  snapshot(issue: string, scope?: string): Promise<string>;
  click(issue: string, ref: string): Promise<string>;
  type(issue: string, ref: string, text: string, opts: { clear: boolean; submit: boolean }): Promise<string>;
  goto(issue: string, url: string): Promise<string>;
  wait(issue: string, opts: { text?: string; url?: string; timeoutMs: number }): Promise<string>;
  /** Downscaled JPEG, base64. */
  shot(issue: string, ref?: string): Promise<string>;
  state(issue: string): Promise<unknown>;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new BridgeError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw new BridgeError(400, "invalid JSON body");
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v === "") throw new BridgeError(400, `${key} is required`);
  return v;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

export const WAIT_DEFAULT_MS = 10_000;
export const WAIT_MAX_MS = 25_000;

async function dispatch(driver: BrowserDriver, action: string, body: Record<string, unknown>) {
  const issue = str(body, "issue");
  switch (action) {
    case "snapshot":
      return { snapshot: await driver.snapshot(issue, optStr(body, "scope")) };
    case "click":
      return { diff: await driver.click(issue, str(body, "ref")) };
    case "type":
      return {
        diff: await driver.type(issue, str(body, "ref"), typeof body.text === "string" ? body.text : "", {
          clear: body.clear === true,
          submit: body.submit === true,
        }),
      };
    case "goto":
      return { diff: await driver.goto(issue, str(body, "url")) };
    case "wait": {
      const text = optStr(body, "text");
      const url = optStr(body, "url");
      if (!text && !url) throw new BridgeError(400, "text or url is required");
      const asked = typeof body.timeout_ms === "number" ? body.timeout_ms : WAIT_DEFAULT_MS;
      const timeoutMs = Math.min(Math.max(asked, 0), WAIT_MAX_MS);
      return { diff: await driver.wait(issue, { text, url, timeoutMs }) };
    }
    case "shot":
      return { jpeg: await driver.shot(issue, optStr(body, "ref")) };
    case "state":
      return { state: await driver.state(issue) };
    default:
      throw new BridgeError(404, `unknown action ${action}`);
  }
}

export interface RunningBridge {
  port: number;
  token: string;
  server: Server;
}

/** Loopback-only HTTP server; every request needs the bearer token. */
export async function startBridgeServer(
  driver: BrowserDriver,
  token = randomBytes(32).toString("hex"),
): Promise<RunningBridge> {
  const server = createServer((req, res) => {
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    void (async () => {
      try {
        if (!authorized(req, token)) throw new BridgeError(401, "unauthorized");
        const match = /^\/v1\/([a-z]+)$/.exec(req.url ?? "");
        if (req.method !== "POST" || !match) throw new BridgeError(404, "not found");
        reply(200, { ok: true, ...(await dispatch(driver, match[1]!, await readJson(req))) });
      } catch (err) {
        if (err instanceof BridgeError) reply(err.status, { ok: false, error: err.message });
        else reply(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { port: (server.address() as AddressInfo).port, token, server };
}
