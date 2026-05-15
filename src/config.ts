export type VerifyGuardLevel = "enforce" | "warn" | "off";

export function readConfig(env: NodeJS.ProcessEnv): VerifyGuardLevel {
  switch (env.PI_VERIFY_GUARD) {
    case "enforce":
    case "warn":
    case "off":
      return env.PI_VERIFY_GUARD;
    default:
      return "enforce";
  }
}
