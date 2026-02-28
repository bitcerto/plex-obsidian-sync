import { describe, expect, it } from "vitest";
import { evaluateLock } from "../core/lock-core";

describe("lock-core", () => {
  it("adquire lock quando nao existe lock atual", () => {
    const decision = evaluateLock(undefined, "device-a", Date.now());
    expect(decision.acquired).toBe(true);
  });

  it("bloqueia quando lock valido pertence a outro device", () => {
    const decision = evaluateLock(
      {
        deviceId: "device-b",
        acquiredAt: 1000,
        expiresAt: Date.now() + 10_000
      },
      "device-a",
      Date.now()
    );

    expect(decision.acquired).toBe(false);
    expect(decision.reason).toContain("device-b");
  });

  it("permite takeover quando lock expirou", () => {
    const now = Date.now();
    const decision = evaluateLock(
      {
        deviceId: "device-b",
        acquiredAt: now - 20_000,
        expiresAt: now - 1
      },
      "device-a",
      now
    );

    expect(decision.acquired).toBe(true);
  });
});
