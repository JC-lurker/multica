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
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  backendDOMNodeId?: number;
}

/** `@eN` refs for one page; cleared whenever the page navigates. */
export class RefTable {
  private byRef = new Map<string, number>();
  private next = 1;

  assign(backendNodeId: number): string {
    const ref = `@e${this.next++}`;
    this.byRef.set(ref, backendNodeId);
    return ref;
  }

  resolve(ref: string): number {
    const id = this.byRef.get(ref);
    if (id === undefined) throw new BridgeError(409, STALE_REF_MESSAGE);
    return id;
  }

  clear(): void {
    this.byRef.clear();
    this.next = 1;
  }
}

/** Renders interactive AX nodes, one per line, assigning a fresh ref to each. */
export function formatSnapshot(nodes: AxNode[], refs: RefTable): string {
  refs.clear();
  const lines: string[] = [];
  for (const node of nodes) {
    const role = String(node.role?.value ?? "");
    if (node.ignored || !INTERACTIVE_ROLES.has(role) || node.backendDOMNodeId === undefined) continue;
    const ref = refs.assign(node.backendDOMNodeId);
    let line = `[${ref}] ${role}`;
    const name = String(node.name?.value ?? "").trim();
    if (name) line += ` ${JSON.stringify(name)}`;
    const value = node.value?.value;
    if (value !== undefined && value !== "") line += ` value=${JSON.stringify(String(value))}`;
    for (const p of node.properties ?? []) {
      if (["checked", "disabled", "expanded", "selected"].includes(p.name) && p.value?.value !== false) {
        line += ` ${p.name}${p.value?.value === true ? "" : `=${String(p.value?.value)}`}`;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export interface BrowserDriver {
  snapshot(issue: string): Promise<string>;
  click(issue: string, ref: string): Promise<void>;
  type(issue: string, ref: string, text: string, opts: { clear: boolean; submit: boolean }): Promise<void>;
  goto(issue: string, url: string): Promise<void>;
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

async function dispatch(driver: BrowserDriver, action: string, body: Record<string, unknown>) {
  const issue = str(body, "issue");
  switch (action) {
    case "snapshot":
      return { snapshot: await driver.snapshot(issue) };
    case "click":
      await driver.click(issue, str(body, "ref"));
      return {};
    case "type":
      await driver.type(issue, str(body, "ref"), typeof body.text === "string" ? body.text : "", {
        clear: body.clear === true,
        submit: body.submit === true,
      });
      return {};
    case "goto":
      await driver.goto(issue, str(body, "url"));
      return {};
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
