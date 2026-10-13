import 'reflect-metadata';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { ConfigError, loadConfig, type AppConfig } from './config/config.js';
import { runMigrations, waitForDatabase } from './db/bootstrap.js';
import { createDataSource } from './db/data-source.js';
import { createApp } from './http/app.js';
import { createShutdown } from './lifecycle.js';
import { createLogger, type Logger } from './logger.js';
import { createJobHandlers } from './modules/generation/job-handlers.js';
import { JobWorker } from './modules/jobs/worker.js';
import { createLlmClient } from './modules/llm/create-llm-client.js';
import { assertPdfFontsReadable } from './modules/pdf/fonts.js';

const WORKER_SHUTDOWN_GRACE_MS = 25_000;
const HTTP_DRAIN_MS = 10_000;
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

function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err) => (err ? reject(err) : resolve(server)));
  });
}

async function main(config: AppConfig, logger: Logger): Promise<void> {
  const dataSource = createDataSource({ url: config.databaseUrl, logger });

  // A broken image should fail now, not on the first PDF download.
  await assertPdfFontsReadable();

  await waitForDatabase(config.databaseUrl, logger);
  await dataSource.initialize();
  await runMigrations(dataSource, logger);

  const server = await listen(createApp({ config, logger, dataSource }), config.port);
  logger.info(
    { port: config.port, llm: config.llm.provider, worker: config.worker.enabled },
    'API listening',
  );

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

  const shutdown = createShutdown({
    server,
    worker,
    dataSource,
    logger,
    exit: (code) => process.exit(code),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    drainMs: HTTP_DRAIN_MS,
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  // State is unknown after a bug: stop and let the container restart (jobs survive via leases).
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
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
