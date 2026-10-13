export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

const JITTER_RATIO = 0.2;

/** Jitter keeps jobs that failed together (an outage) from all retrying at once. */
export function retryDelayMs(
  attempt: number,
  delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  random: () => number = Math.random,
): number {
  if (delays.length === 0) return 0;
  const base = delays[Math.min(Math.max(attempt, 1), delays.length) - 1]!;
  const jitter = base * JITTER_RATIO * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}
