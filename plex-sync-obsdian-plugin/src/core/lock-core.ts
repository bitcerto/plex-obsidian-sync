import type { SyncLockFile } from "../types";

export interface LockDecision {
  acquired: boolean;
  reason?: string;
}

export function evaluateLock(
  currentLock: SyncLockFile | undefined,
  deviceId: string,
  nowMs: number
): LockDecision {
  if (!currentLock) {
    return { acquired: true };
  }

  if (currentLock.deviceId === deviceId) {
    return { acquired: true };
  }

  if (currentLock.expiresAt <= nowMs) {
    return { acquired: true };
  }

  return {
    acquired: false,
    reason: `lock mantido por ${currentLock.deviceId} ate ${new Date(currentLock.expiresAt).toISOString()}`
  };
}
