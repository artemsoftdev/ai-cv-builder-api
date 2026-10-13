import 'reflect-metadata';
import type { Server } from 'node:http';
import { ConfigError, loadConfig, type AppConfig } from './config/config.js';
import { runMigrations, waitForDatabase } from './db/bootstrap.js';
import { createDataSource } from './db/data-source.js';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

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

/** Stops accepting connections and waits for in-flight requests; idle keep-alives close now. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections();
  });
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger(config.logLevel);
  const dataSource = createDataSource({ url: config.databaseUrl, logger });

  // Migrations run before the port opens, so no request ever sees an old schema.
  await waitForDatabase(config.databaseUrl, logger);
  await dataSource.initialize();
  await runMigrations(dataSource, logger);

  const app = createApp({ config, logger, dataSource });
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, llm: config.llm.provider, worker: config.worker.enabled },
      'API listening',
    );
  });
  // Part 2: start the job worker here, and stop it in shutdown() before the database closes.

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
      await closeServer(server);
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
  // A bug left a promise unhandled: state is unknown, so restart cleanly (jobs are lease-based
  // and survive a restart) instead of limping on.
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. database unreachable during boot).
  console.error('Fatal error during startup', err);
  process.exit(1);
});
