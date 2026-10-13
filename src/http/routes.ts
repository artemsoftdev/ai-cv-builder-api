import { Router, type Request } from 'express';
import { createAuthRouter } from '../modules/auth/auth.router.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { SessionService } from '../modules/auth/session.service.js';
import { createCvsRouter } from '../modules/cvs/cvs.router.js';
import { CvService } from '../modules/cvs/cv.service.js';
import { createGenerationRouter } from '../modules/generation/generation.router.js';
import { GenerationService } from '../modules/generation/generation.service.js';
import { createHealthRouter } from '../modules/health/health.router.js';
import { DEFAULT_MAX_ACTIVE_GENERATIONS } from '../modules/ingestion/generation-capacity.js';
import { createIngestionRouter } from '../modules/ingestion/ingestion.router.js';
import { IngestionService } from '../modules/ingestion/ingestion.service.js';
import { getAuth } from './auth-context.js';
import {
  DEFAULT_ANSWER_RATE_LIMIT,
  DEFAULT_CREDENTIALS_RATE_LIMIT,
  DEFAULT_GENERATION_RATE_LIMIT,
  type AppDeps,
  type AppOptions,
} from './deps.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createRequireAuth } from './middleware/require-auth.js';

/** Rate-limit key for routes behind requireAuth: the user, not the IP. */
const byUser = (req: Request) => getAuth(req).user.id;

/** Composes every module router under /api. Services are created once per app instance. */
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
      credentialsRateLimit: createRateLimiter(
        options.credentialsRateLimit ?? DEFAULT_CREDENTIALS_RATE_LIMIT,
      ),
      cookieSecure: config.cookieSecure,
    }),
  );

  // Everything under /cvs requires a session. Authenticate once here, then let each feature
  // router add its own routes on the same path (part 3 adds GET /:id/pdf).
  const maxActiveGenerations = options.maxActiveGenerations ?? DEFAULT_MAX_ACTIVE_GENERATIONS;
  // One budget for every generation start (create + retry): each costs LLM calls.
  const generationRateLimit = createRateLimiter(
    options.generationRateLimit ?? DEFAULT_GENERATION_RATE_LIMIT,
    byUser,
  );
  const cvs = Router();
  cvs.use(requireAuth);
  cvs.use(createCvsRouter({ cvService }));
  cvs.use(
    createIngestionRouter({
      ingestionService: new IngestionService({ dataSource, cvService, maxActiveGenerations }),
      generationRateLimit,
    }),
  );
  cvs.use(
    createGenerationRouter({
      generationService: new GenerationService({ dataSource, cvService, maxActiveGenerations }),
      generationRateLimit,
      answerRateLimit: createRateLimiter(
        options.answerRateLimit ?? DEFAULT_ANSWER_RATE_LIMIT,
        byUser,
      ),
    }),
  );
  api.use('/cvs', cvs);

  return api;
}
