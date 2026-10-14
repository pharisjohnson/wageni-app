/**
 * Escalating failure throttle, shared by the kiosk lookups and the staff PIN
 * check. Pure functions over a small state object so they are easy to test.
 *
 * - A window collects failures. Reaching `maxFailures` locks for
 *   `baseLockMs * 2^(level-1)`, capped at `maxLockMs`.
 * - `level` goes up when a new lock starts within `levelDecayMs` of the last
 *   one and resets to 1 after a quiet period, so a persistent guesser sees
 *   ever longer locks while an honest typo costs one short lock.
 * - While locked nothing is counted and callers answer without touching data.
 */
export type ThrottleState = {
  windowStart?: number;
  failures?: number;
  lockUntil?: number;
  level?: number;
  lastLockAt?: number;
};

export type ThrottleConfig = {
  windowMs: number;
  maxFailures: number;
  baseLockMs: number;
  maxLockMs: number;
  levelDecayMs: number;
};

export function throttleLocked(state: ThrottleState, now = Date.now()): boolean {
  return (state.lockUntil ?? 0) > now;
}

export function lockDurationMs(level: number, cfg: ThrottleConfig): number {
  return Math.min(cfg.maxLockMs, cfg.baseLockMs * 2 ** Math.max(0, level - 1));
}

/** The state after one more failure; `locked` is true when this failure started a lock. */
export function recordFailure(
  state: ThrottleState,
  cfg: ThrottleConfig,
  now = Date.now(),
): { state: ThrottleState; locked: boolean } {
  const open = state.windowStart !== undefined && now - state.windowStart < cfg.windowMs;
  const failures = (open ? (state.failures ?? 0) : 0) + 1;
  if (failures < cfg.maxFailures) {
    return { state: { ...state, windowStart: open ? state.windowStart : now, failures }, locked: false };
  }
  const recent = state.lastLockAt !== undefined && now - state.lastLockAt < cfg.levelDecayMs;
  const level = recent ? (state.level ?? 1) + 1 : 1;
  return {
    state: {
      windowStart: undefined,
      failures: 0,
      lockUntil: now + lockDurationMs(level, cfg),
      level,
      lastLockAt: now,
    },
    locked: true,
  };
}
