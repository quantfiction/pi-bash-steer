import { describe, expect, it, vi } from "vitest";
import piVerifyGuard from "./index.js";

describe("pi-verify-guard skeleton", () => {
  it("registers a session_start listener", async () => {
    const on = vi.fn();
    const pi = { on } as unknown as Parameters<typeof piVerifyGuard>[0];

    await piVerifyGuard(pi);

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });
});
