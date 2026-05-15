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
