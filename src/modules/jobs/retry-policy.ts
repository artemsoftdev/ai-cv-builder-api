/** Backoff before attempts 2, 3, 4...: 5 s, 30 s, then 2 min for every later one. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

const JITTER_RATIO = 0.2;

/**
 * Delay before retrying a job whose attempt number `attempt` (1-based) just failed: the table
 * value with +-20% jitter, so jobs that failed together (e.g. during an outage) do not all come
 * back at the same instant.
 */
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
