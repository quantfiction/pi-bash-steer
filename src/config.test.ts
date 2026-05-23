import { describe, expect, it } from "vitest";
import { readBuiltinsConfig, readConfig } from "./config.js";

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

describe("readBuiltinsConfig", () => {
  it("defaults to on when PI_BASH_STEER_BUILTINS is unset", () => {
    expect(readBuiltinsConfig({})).toBe("on");
  });

  it("returns off when PI_BASH_STEER_BUILTINS=off", () => {
    expect(readBuiltinsConfig({ PI_BASH_STEER_BUILTINS: "off" })).toBe("off");
  });

  it("returns on when PI_BASH_STEER_BUILTINS=on (explicit)", () => {
    expect(readBuiltinsConfig({ PI_BASH_STEER_BUILTINS: "on" })).toBe("on");
  });

  it("fails safe to on for unknown values (built-ins are the safer default)", () => {
    expect(readBuiltinsConfig({ PI_BASH_STEER_BUILTINS: "true" })).toBe("on");
    expect(readBuiltinsConfig({ PI_BASH_STEER_BUILTINS: "" })).toBe("on");
  });
});
