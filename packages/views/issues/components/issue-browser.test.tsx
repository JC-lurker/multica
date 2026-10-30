import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIssueBrowserStore } from "@multica/core/issues/stores/issue-browser-store";
import { IssueBrowserPanel } from "./issue-browser";

// Resolves `$ => $.browser.x` to "browser.x" so assertions stay locale-free.
vi.mock("../../i18n", () => ({
  useT: () => ({
    t: (select: (r: unknown) => unknown) => {
      const path: string[] = [];
      const proxy: unknown = new Proxy(
        {},
        {
          get: (_t, key: string) => {
            path.push(key);
            return proxy;
          },
        },
      );
      select(proxy);
      return path.join(".");
    },
  }),
}));

vi.mock("@multica/core/api", () => ({ api: {} }));

const state = {
  url: "about:blank",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

function installBridge() {
  const ok = Promise.resolve({ ok: true as const, value: true });
  const bridge = {
    show: vi.fn(() => Promise.resolve({ ok: true as const, value: state })),
    setBounds: vi.fn(() => ok),
    hide: vi.fn(() => ok),
    navigate: vi.fn(() => ok),
    control: vi.fn(() => ok),
    pickElement: vi.fn(),
    cancelPick: vi.fn(() => ok),
    draw: vi.fn(),
    capture: vi.fn(),
    onState: vi.fn(() => () => {}),
  };
  (window as unknown as { desktopAPI: unknown }).desktopAPI = { issueBrowser: bridge };
  return bridge;
}

describe("IssueBrowserPanel", () => {
  beforeEach(() => {
    useIssueBrowserStore.setState({
      openIssueIds: { "issue-1": true },
      profiles: [],
      issueProfiles: {},
    });
  });

  it("renders nothing without the desktop bridge", () => {
    delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
    const { container } = render(<IssueBrowserPanel issueId="issue-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("attaches the view with the default profile", () => {
    const bridge = installBridge();
    render(<IssueBrowserPanel issueId="issue-1" />);
    expect(bridge.show).toHaveBeenCalledWith("issue-1", expect.any(Object), undefined, "default");
  });

  it("uses the profile saved for the issue", () => {
    useIssueBrowserStore.setState({
      profiles: [{ id: "work", name: "Work" }],
      issueProfiles: { "issue-1": "work" },
    });
    const bridge = installBridge();
    render(<IssueBrowserPanel issueId="issue-1" />);
    expect(bridge.show).toHaveBeenCalledWith("issue-1", expect.any(Object), undefined, "work");
  });

  it("falls back to default when the saved profile is gone", () => {
    useIssueBrowserStore.setState({ issueProfiles: { "issue-1": "deleted" } });
    const bridge = installBridge();
    render(<IssueBrowserPanel issueId="issue-1" />);
    expect(bridge.show).toHaveBeenCalledWith("issue-1", expect.any(Object), undefined, "default");
  });

  it("creates a profile and re-attaches the view under it", async () => {
    const bridge = installBridge();
    render(<IssueBrowserPanel issueId="issue-1" />);
    fireEvent.click(screen.getByRole("button", { name: "browser.profile_add" }));
    fireEvent.change(screen.getByLabelText("browser.profile_name_placeholder"), {
      target: { value: "Work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "browser.profile_create" }));
    await waitFor(() =>
      expect(bridge.show).toHaveBeenLastCalledWith("issue-1", expect.any(Object), undefined, "work"),
    );
    expect(useIssueBrowserStore.getState().issueProfiles).toEqual({ "issue-1": "work" });
  });

  it("detaches the native view while an overlay is open and restores it after", async () => {
    const bridge = installBridge();
    render(<IssueBrowserPanel issueId="issue-1" />);
    bridge.hide.mockClear();
    bridge.show.mockClear();

    const dialog = document.createElement("div");
    dialog.setAttribute("data-slot", "dialog-content");
    dialog.setAttribute("data-open", "");
    await act(async () => {
      document.body.appendChild(dialog);
    });
    await waitFor(() => expect(bridge.hide).toHaveBeenCalledWith("issue-1"));

    await act(async () => {
      dialog.remove();
    });
    await waitFor(() => expect(bridge.show).toHaveBeenCalledTimes(1));
  });

  it("ignores keepMounted overlay content that is closed", async () => {
    const bridge = installBridge();
    render(<IssueBrowserPanel issueId="issue-1" />);
    bridge.hide.mockClear();
    const closed = document.createElement("div");
    closed.setAttribute("data-slot", "popover-content");
    await act(async () => {
      document.body.appendChild(closed);
    });
    expect(bridge.hide).not.toHaveBeenCalled();
    closed.remove();
  });
});
