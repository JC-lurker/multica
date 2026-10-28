// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useIssueBrowserStore } from "./issue-browser-store";

describe("issue browser profiles", () => {
  beforeEach(() => {
    useIssueBrowserStore.setState({ profiles: [], issueProfiles: {} });
  });

  it("slugs names into unique ids", () => {
    const { addProfile } = useIssueBrowserStore.getState();
    expect(addProfile("Work Account")).toBe("work-account");
    expect(addProfile("work account")).toBe("work-account-2");
    expect(useIssueBrowserStore.getState().profiles.map((p) => p.name)).toEqual([
      "Work Account",
      "work account",
    ]);
  });

  it("never reuses the default id and rejects blank names", () => {
    const { addProfile } = useIssueBrowserStore.getState();
    expect(addProfile("  ")).toBeNull();
    expect(addProfile("Default")).not.toBe("default");
    expect(addProfile("日本語")).toBe("profile-2");
  });

  it("records per-issue choice and clears it for the default", () => {
    const { setIssueProfile } = useIssueBrowserStore.getState();
    setIssueProfile("i1", "work");
    expect(useIssueBrowserStore.getState().issueProfiles).toEqual({ i1: "work" });
    setIssueProfile("i1", "default");
    expect(useIssueBrowserStore.getState().issueProfiles).toEqual({});
  });
});
