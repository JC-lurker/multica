# Issue browser

Per-issue embedded browser in the desktop app (PROX-141, PRs #3 and #4). Next: agent control (PROX-146).

## Description

Each issue detail view can open a browser panel. The desktop main process owns one Electron `WebContentsView` per issue. The renderer only supplies bounds and sends commands over IPC. Contract: `apps/desktop/src/shared/issue-browser.ts`. Implementation: `apps/desktop/src/main/issue-browser*.ts`. UI: `packages/views/issues/components/issue-browser.tsx`.

## Features

- One page per issue. It survives panel close and issue switching, and is released when its window closes.
- Shared persistent session `persist:multica-browser`, so logins persist.
- Hardening: http(s) only, all permission requests denied, app tokens stripped from the UA.
- Address bar (host:port input accepted), back, forward, reload, stop.
- Element picker. Returns selector, tag, text, html, rect, page URL and title.
- Draw overlay (pen, rect, arrow, eraser, color, undo, clear).
- Screenshot capture (full or rect) that can be posted as an issue comment.
- Resizable panel.

## Plan: agents control the browser

Goal: an agent running on a runtime can drive the browser a user sees on an issue, so the user can watch and take over.

1. Transport: the daemon is a separate process from the desktop app. Add a local-only channel from daemon to desktop (loopback WebSocket or unix socket with a per-launch token). Not exposed to the server.
2. Command surface: reuse the existing IPC handlers and add `click`, `type`, `press`, `scroll`, `eval` (restricted), `snapshot` (accessibility tree plus text), `wait`. Reuse `pick-element` selectors as targets.
3. Agent CLI: `multica browser <navigate|snapshot|click|type|screenshot> --issue <id>`, scoped to the agent's current issue.
4. Safety: a per-issue "allow agent control" toggle that is off by default. Show a visible "agent is controlling" banner with a stop button. User input pauses the agent. Origin allowlist with confirmation for new origins. Keep permissions denied. Log every action to the issue timeline. Never expose cookies or storage to the agent.
5. Tests: unit tests for command validation (extend `issue-browser-url.test.ts`) and one Electron e2e that navigates and snapshots a local fixture page.

Open questions:
- Should agents get a separate session rather than the user's logged-in one? Default proposal: separate, with an opt-in to share.
- Should the daemon connect only when the desktop app is on the same machine? Remote runtimes would need a relay (out of scope for v1).
