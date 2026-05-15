import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

describe("readConfig", () => {
  it("defaults to enforce when PI_BASH_STEER is unset", () => {
    expect(readConfig({})).toBe("enforce");
  });

  it.each([
    ["enforce", "enforce"],
    ["warn", "warn"],
    ["off", "off"],
  ] as const)("reads %s", (value, expected) => {
    expect(readConfig({ PI_BASH_STEER: value })).toBe(expected);
  });

  it("falls back to enforce for unknown values", () => {
    expect(readConfig({ PI_BASH_STEER: "disabled" })).toBe("enforce");
  });
});
