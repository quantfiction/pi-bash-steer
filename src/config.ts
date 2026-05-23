export type BashSteerLevel = "enforce" | "warn" | "off";

export function readConfig(env: NodeJS.ProcessEnv): BashSteerLevel {
  switch (env.PI_BASH_STEER) {
    case "enforce":
    case "warn":
    case "off":
      return env.PI_BASH_STEER;
    default:
      return "enforce";
  }
}

/**
 * Wholesale opt-out for built-in universal-footgun defaults. Default
 * "on". Setting `PI_BASH_STEER_BUILTINS=off` skips merging the
 * `BUILTIN_POLICY` and yields the pre-builtins behavior — only the
 * project's `mise.toml [commands_meta.*]` patterns fire.
 *
 * Read once at extension activation alongside `PI_BASH_STEER`.
 */
export type BuiltinsLevel = "on" | "off";

export function readBuiltinsConfig(env: NodeJS.ProcessEnv): BuiltinsLevel {
  return env.PI_BASH_STEER_BUILTINS === "off" ? "off" : "on";
}
