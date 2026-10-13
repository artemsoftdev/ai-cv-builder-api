import 'reflect-metadata';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { ConfigError, loadConfig, type AppConfig } from './config/config.js';
import { runMigrations, waitForDatabase } from './db/bootstrap.js';
import { createDataSource } from './db/data-source.js';
import { createApp } from './http/app.js';
import { createLogger, type Logger } from './logger.js';
import { createJobHandlers } from './modules/generation/job-handlers.js';
import { JobWorker } from './modules/jobs/worker.js';
import { createLlmClient } from './modules/llm/create-llm-client.js';
import { assertPdfFontsReadable } from './modules/pdf/fonts.js';

/** Running jobs get WORKER_SHUTDOWN_GRACE_MS to finish; HTTP draining and the DB need a bit more. */
const WORKER_SHUTDOWN_GRACE_MS = 25_000;
const SHUTDOWN_TIMEOUT_MS = WORKER_SHUTDOWN_GRACE_MS + 10_000;

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

/** Resolves once the port is bound; rejects on EADDRINUSE and similar. */
function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err) => (err ? reject(err) : resolve(server)));
  });
}

/** Stops accepting connections and waits for in-flight requests; idle keep-alives close now. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections();
  });
}

async function main(config: AppConfig, logger: Logger): Promise<void> {
  const dataSource = createDataSource({ url: config.databaseUrl, logger });

  // A broken image (fonts not copied) should fail now, not on the first PDF download.
  await assertPdfFontsReadable();

  // Migrations run before the port opens, so no request ever sees an old schema.
  await waitForDatabase(config.databaseUrl, logger);
  await dataSource.initialize();
  await runMigrations(dataSource, logger);

  const server = await listen(createApp({ config, logger, dataSource }), config.port);
  logger.info(
    { port: config.port, llm: config.llm.provider, worker: config.worker.enabled },
    'API listening',
  );

  // The worker runs in this process and shares the connection pool. With WORKER_ENABLED=false
  // jobs simply stay queued until a process with a worker picks them up.
  const worker = config.worker.enabled
    ? new JobWorker(
        {
          dataSource,
          logger: logger.child({ component: 'worker' }),
          handlers: createJobHandlers({
            dataSource,
            llm: createLlmClient(config.llm, logger),
            logger: logger.child({ component: 'generation' }),
          }),
        },
        { concurrency: config.worker.concurrency, shutdownGraceMs: WORKER_SHUTDOWN_GRACE_MS },
      )
    : null;
  worker?.start();

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'Shutting down');
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    try {
      // Order matters: no new requests, then no new jobs (running ones finish or are handed
      // back to the queue), then close the pool both of them use.
      await closeServer(server);
      await worker?.stop();
      await dataSource.destroy();
      logger.info('Shutdown complete');
      process.exit(exitCode);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  // A bug left a promise unhandled or an exception uncaught: state is unknown, so stop cleanly
  // and let the container restart us (jobs are lease-based and survive a restart) instead of
  // limping on. The forced-exit timer bounds a shutdown that hangs because of the same bug.
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

const config = loadConfigOrExit();
const logger = createLogger(config.logLevel);
main(config, logger).catch((err: unknown) => {
  // Database unreachable, migration failed, port taken, fonts missing...
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
