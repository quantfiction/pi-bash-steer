import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

describe("readConfig", () => {
  it("defaults to enforce when PI_VERIFY_GUARD is unset", () => {
    expect(readConfig({})).toBe("enforce");
  });

  it.each([
    ["enforce", "enforce"],
    ["warn", "warn"],
    ["off", "off"],
  ] as const)("reads %s", (value, expected) => {
    expect(readConfig({ PI_VERIFY_GUARD: value })).toBe(expected);
  });

  it("falls back to enforce for unknown values", () => {
    expect(readConfig({ PI_VERIFY_GUARD: "disabled" })).toBe("enforce");
  });
});
