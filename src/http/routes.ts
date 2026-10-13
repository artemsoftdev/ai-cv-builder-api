import { Router, type Request } from 'express';
import { createAuthRouter } from '../modules/auth/auth.router.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { SessionService } from '../modules/auth/session.service.js';
import { createCvsRouter } from '../modules/cvs/cvs.router.js';
import { CvService } from '../modules/cvs/cv.service.js';
import { createGenerationRouter } from '../modules/generation/generation.router.js';
import { GenerationService } from '../modules/generation/generation.service.js';
import { createHealthRouter } from '../modules/health/health.router.js';
import {
  DEFAULT_MAX_ACTIVE_GENERATIONS,
  DEFAULT_MAX_LIVE_JOBS,
} from '../modules/ingestion/generation-capacity.js';
import { createIngestionRouter } from '../modules/ingestion/ingestion.router.js';
import { IngestionService } from '../modules/ingestion/ingestion.service.js';
import { createPdfRouter } from '../modules/pdf/pdf.router.js';
import { getAuth } from './auth-context.js';
import {
  DEFAULT_ACCOUNT_RATE_LIMIT,
  DEFAULT_ANSWER_RATE_LIMIT,
  DEFAULT_CREDENTIALS_RATE_LIMIT,
  DEFAULT_GENERATION_RATE_LIMIT,
  DEFAULT_PDF_RATE_LIMIT,
  type AppDeps,
  type AppOptions,
} from './deps.js';
import { createRateLimiter, emailKey } from './middleware/rate-limit.js';
import { createRequireAuth } from './middleware/require-auth.js';

const byUser = (req: Request) => getAuth(req).user.id;

export function createApiRouter(deps: AppDeps, options: AppOptions = {}): Router {
  const { config, dataSource } = deps;
  const sessions = new SessionService(dataSource);
  const requireAuth = createRequireAuth(sessions, config.cookieSecure);
  const cvService = new CvService(dataSource);

  const api = Router();

  api.use('/health', createHealthRouter(deps));

  api.use(
    '/auth',
    createAuthRouter({
      authService: new AuthService(dataSource, sessions),
      sessions,
      requireAuth,
      credentialsRateLimits: [
        createRateLimiter(options.credentialsRateLimit ?? DEFAULT_CREDENTIALS_RATE_LIMIT),
        createRateLimiter(options.accountRateLimit ?? DEFAULT_ACCOUNT_RATE_LIMIT, {
          key: emailKey,
          countFailuresOnly: true,
        }),
      ],
      cookieSecure: config.cookieSecure,
    }),
  );

  const capacity = {
    maxActiveGenerations: options.maxActiveGenerations ?? DEFAULT_MAX_ACTIVE_GENERATIONS,
    maxLiveJobs: options.maxLiveJobs ?? DEFAULT_MAX_LIVE_JOBS,
  };
  // Shared by create and retry: both cost LLM calls.
  const generationRateLimit = createRateLimiter(
    options.generationRateLimit ?? DEFAULT_GENERATION_RATE_LIMIT,
    { key: byUser, countSuccessesOnly: true },
  );
  const cvs = Router();
  cvs.use(requireAuth);
  cvs.use(createCvsRouter({ cvService }));
  cvs.use(
    createIngestionRouter({
      ingestionService: new IngestionService({ dataSource, cvService, capacity }),
      generationRateLimit,
    }),
  );
  cvs.use(
    createGenerationRouter({
      generationService: new GenerationService({ dataSource, cvService, capacity }),
      generationRateLimit,
      answerRateLimit: createRateLimiter(options.answerRateLimit ?? DEFAULT_ANSWER_RATE_LIMIT, {
        key: byUser,
        countSuccessesOnly: true,
      }),
    }),
  );
  cvs.use(
    createPdfRouter({
      cvService,
      pdfRateLimit: createRateLimiter(options.pdfRateLimit ?? DEFAULT_PDF_RATE_LIMIT, {
        key: byUser,
      }),
    }),
  );
  api.use('/cvs', cvs);

  return api;
}
