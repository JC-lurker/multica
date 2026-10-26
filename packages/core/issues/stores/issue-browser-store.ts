import { create } from "zustand";

interface IssueBrowserState {
  /** Issues whose browser panel is open. In-memory: guest pages die with the app. */
  openIssueIds: Record<string, true>;
  toggle: (issueId: string) => void;
  close: (issueId: string) => void;
}

export const useIssueBrowserStore = create<IssueBrowserState>((set) => ({
  openIssueIds: {},
  toggle: (issueId) =>
    set((s) => {
      const next = { ...s.openIssueIds };
      if (next[issueId]) delete next[issueId];
      else next[issueId] = true;
      return { openIssueIds: next };
    }),
  close: (issueId) =>
    set((s) => {
      if (!s.openIssueIds[issueId]) return s;
      const next = { ...s.openIssueIds };
      delete next[issueId];
      return { openIssueIds: next };
    }),
}));
