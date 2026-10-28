import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "../../platform/storage";

export const ISSUE_BROWSER_MIN_WIDTH = 320;
export const ISSUE_BROWSER_DEFAULT_WIDTH = 480;

export const DEFAULT_BROWSER_PROFILE_ID = "default";

export interface BrowserProfile {
  /** Slug used as the Electron partition suffix; never changes after creation. */
  id: string;
  name: string;
}

interface IssueBrowserState {
  /** Issues whose browser panel is open. In-memory: guest pages die with the app. */
  openIssueIds: Record<string, true>;
  /** Panel width in px, shared by all issues and saved on this device. */
  width: number;
  toggle: (issueId: string) => void;
  close: (issueId: string) => void;
  setWidth: (width: number) => void;
  /** Named profiles besides the built-in default, saved on this device. */
  profiles: BrowserProfile[];
  /** Profile chosen per issue; absent means the default profile. */
  issueProfiles: Record<string, string>;
  addProfile: (name: string) => string | null;
  setIssueProfile: (issueId: string, profileId: string) => void;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
}

export const useIssueBrowserStore = create<IssueBrowserState>()(
  persist(
    (set, get) => ({
      openIssueIds: {},
      width: ISSUE_BROWSER_DEFAULT_WIDTH,
      profiles: [],
      issueProfiles: {},
      addProfile: (rawName) => {
        const name = rawName.trim();
        if (!name) return null;
        const taken = new Set(get().profiles.map((p) => p.id));
        const base = slugify(name) || "profile";
        let id = base === DEFAULT_BROWSER_PROFILE_ID ? "profile" : base;
        for (let n = 2; taken.has(id) || id === DEFAULT_BROWSER_PROFILE_ID; n++) {
          id = `${base}-${n}`;
        }
        set((s) => ({ profiles: [...s.profiles, { id, name }] }));
        return id;
      },
      setIssueProfile: (issueId, profileId) =>
        set((s) => {
          const next = { ...s.issueProfiles };
          if (profileId === DEFAULT_BROWSER_PROFILE_ID) delete next[issueId];
          else next[issueId] = profileId;
          return { issueProfiles: next };
        }),
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
      setWidth: (width) =>
        set({ width: Math.max(ISSUE_BROWSER_MIN_WIDTH, Math.round(width)) }),
    }),
    {
      name: "multica_issue_browser",
      storage: createJSONStorage(() => defaultStorage),
      partialize: ({ width, profiles, issueProfiles }) => ({ width, profiles, issueProfiles }),
      merge: (persisted, current) => {
        const width =
          persisted && typeof persisted === "object" && "width" in persisted
            ? Number(persisted.width)
            : NaN;
        const saved = (persisted ?? {}) as Partial<
          Pick<IssueBrowserState, "profiles" | "issueProfiles">
        >;
        return {
          ...current,
          width: Number.isFinite(width)
            ? Math.max(ISSUE_BROWSER_MIN_WIDTH, width)
            : current.width,
          profiles: Array.isArray(saved.profiles) ? saved.profiles : current.profiles,
          issueProfiles:
            saved.issueProfiles && typeof saved.issueProfiles === "object"
              ? saved.issueProfiles
              : current.issueProfiles,
        };
      },
    },
  ),
);
