// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseIssueBrowserProfile } from "./issue-browser";

describe("parseIssueBrowserProfile", () => {
  it("defaults when missing", () => {
    expect(parseIssueBrowserProfile(undefined)).toBe("default");
    expect(parseIssueBrowserProfile(null)).toBe("default");
  });
  it("accepts slug ids", () => {
    expect(parseIssueBrowserProfile("work-2")).toBe("work-2");
  });
  it("rejects anything that could escape the partition name", () => {
    for (const bad of ["", "Work", "a/b", "a:b", "-x", "a b", "x".repeat(41), 5, {}]) {
      expect(parseIssueBrowserProfile(bad)).toBeNull();
    }
  });
});
