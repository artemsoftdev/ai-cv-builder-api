import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeServer, createShutdown, type ShutdownDeps } from './lifecycle.js';
import { createLogger } from './logger.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeServer() {
  let onClosed: ((err?: Error) => void) | undefined;
  return {
    close: vi.fn((cb: (err?: Error) => void) => {
      onClosed = cb;
    }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(() => onClosed?.()),
    finishRequests: () => onClosed?.(),
  };
}

function setup(overrides: Partial<ShutdownDeps> = {}) {
  const events: string[] = [];
  const server = fakeServer();
  const workerStopped = deferred();
  const worker = {
    stop: vi.fn(async () => {
      events.push('worker.stop');
      await workerStopped.promise;
      events.push('worker.stopped');
    }),
  };
  const dataSource = {
    destroy: vi.fn(() => {
      events.push('db.destroy');
      return Promise.resolve();
    }),
  };
  const exit = vi.fn((code: number) => void events.push(`exit ${code}`));
  const shutdown = createShutdown({
    server: server as unknown as ShutdownDeps['server'],
    worker,
    dataSource,
    logger: createLogger('silent'),
    exit,
    timeoutMs: 35_000,
    drainMs: 10_000,
    ...overrides,
  });
  return { shutdown, server, worker, workerStopped, dataSource, exit, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createShutdown', () => {
  it('stops the worker while HTTP drains and closes the pool last', async () => {
    const { shutdown, server, workerStopped, events } = setup();
    const done = shutdown('SIGTERM', 0);

    await Promise.resolve();
    expect(server.close).toHaveBeenCalled();
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(events).toEqual(['worker.stop']);

    workerStopped.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).not.toContain('db.destroy');

    server.finishRequests();
    await done;
    expect(events).toEqual(['worker.stop', 'worker.stopped', 'db.destroy', 'exit 0']);
  });

  it('runs once', async () => {
    const { shutdown, server, workerStopped, worker } = setup();
    workerStopped.resolve();
    const first = shutdown('SIGTERM', 0);
    const second = shutdown('SIGINT', 0);
    server.finishRequests();
    await Promise.all([first, second]);
    expect(worker.stop).toHaveBeenCalledTimes(1);
  });

  it('exits with 1 when shutting down fails', async () => {
    const { shutdown, server, workerStopped, dataSource, exit } = setup();
    dataSource.destroy.mockRejectedValueOnce(new Error('pool already closed'));
    workerStopped.resolve();
    const done = shutdown('unhandledRejection', 1);
    server.finishRequests();
    await done;
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces the exit when shutdown hangs', async () => {
    vi.useFakeTimers();
    const { shutdown, exit } = setup({ worker: { stop: () => new Promise(() => {}) } });
    void shutdown('SIGTERM', 0);
    await vi.advanceTimersByTimeAsync(34_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('closeServer', () => {
  it('cuts open connections after the drain period', async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const closed = closeServer(server as unknown as ShutdownDeps['server'], 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(server.closeAllConnections).toHaveBeenCalled();
    await expect(closed).resolves.toBeUndefined();
  });
});
