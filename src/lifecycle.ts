import type { Server } from 'node:http';
import type { Logger } from './logger.js';

type ClosableServer = Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>;

export interface ShutdownDeps {
  server: ClosableServer;
  worker: { stop(): Promise<void> } | null;
  dataSource: { destroy(): Promise<void> };
  logger: Logger;
  exit: (code: number) => void;
  /** Must stay below the container's stop grace period. */
  timeoutMs: number;
  drainMs: number;
}

export function closeServer(server: ClosableServer, drainMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cutOff = setTimeout(() => server.closeAllConnections(), drainMs);
    cutOff.unref();
    server.close((err) => {
      clearTimeout(cutOff);
      if (err) reject(err);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

/** HTTP drains while the worker hands its jobs back, not one after the other. */
export function createShutdown(
  deps: ShutdownDeps,
): (reason: string, code: number) => Promise<void> {
  const { server, worker, dataSource, logger, exit } = deps;
  let started = false;
  return async (reason, code) => {
    if (started) return;
    started = true;
    logger.info({ reason }, 'Shutting down');
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      exit(1);
    }, deps.timeoutMs);
    forceExit.unref();
    try {
      await Promise.all([closeServer(server, deps.drainMs), worker?.stop()]);
      await dataSource.destroy();
      logger.info('Shutdown complete');
      exit(code);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      exit(1);
    } finally {
      clearTimeout(forceExit);
    }
  };
}
