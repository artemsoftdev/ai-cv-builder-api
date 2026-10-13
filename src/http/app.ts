import cookieParser from 'cookie-parser';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { AppDeps, AppOptions } from './deps.js';
import { requireCsrfHeader } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { createApiRouter } from './routes.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function createApp(deps: AppDeps, options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);

  app.use(requestLogger(deps.logger));
  app.use(helmet());
  app.use(noStore);
  app.use(requireCsrfHeader);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api', createApiRouter(deps, options));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
