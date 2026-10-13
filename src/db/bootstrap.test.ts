import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { waitForDatabase } from './bootstrap.js';

const URL = 'postgres://app:secret@db:5432/app';

describe('waitForDatabase', () => {
  it('retries until the database answers', async () => {
    const check = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('the database system is starting up'))
      .mockResolvedValueOnce(undefined);
    await waitForDatabase(URL, createLogger('silent'), { attempts: 5, delayMs: 1, check });
    expect(check).toHaveBeenCalledTimes(3);
    expect(check).toHaveBeenCalledWith(URL);
  });

  it('gives up after the last attempt with the last error', async () => {
    const check = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(
      waitForDatabase(URL, createLogger('silent'), { attempts: 3, delayMs: 1, check }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(check).toHaveBeenCalledTimes(3);
  });
});
