import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_DELAYS_MS, retryDelayMs } from './retry-policy.js';

describe('retryDelayMs', () => {
  const noJitter = () => 0.5;

  it('follows the backoff table and repeats its last entry', () => {
    expect(retryDelayMs(1, DEFAULT_RETRY_DELAYS_MS, noJitter)).toBe(5_000);
    expect(retryDelayMs(2, DEFAULT_RETRY_DELAYS_MS, noJitter)).toBe(30_000);
    expect(retryDelayMs(3, DEFAULT_RETRY_DELAYS_MS, noJitter)).toBe(120_000);
    expect(retryDelayMs(9, DEFAULT_RETRY_DELAYS_MS, noJitter)).toBe(120_000);
  });

  it('adds at most +-20% jitter', () => {
    expect(retryDelayMs(1, DEFAULT_RETRY_DELAYS_MS, () => 0)).toBe(4_000);
    expect(retryDelayMs(1, DEFAULT_RETRY_DELAYS_MS, () => 0.999_999)).toBe(6_000);
    for (let i = 0; i < 100; i++) {
      const delay = retryDelayMs(2);
      expect(delay).toBeGreaterThanOrEqual(24_000);
      expect(delay).toBeLessThanOrEqual(36_000);
    }
  });

  it('supports an empty or zero table (tests run retries immediately)', () => {
    expect(retryDelayMs(1, [])).toBe(0);
    expect(retryDelayMs(2, [0])).toBe(0);
  });
});
