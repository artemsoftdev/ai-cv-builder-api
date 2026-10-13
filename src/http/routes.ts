import { Router } from 'express';
import { createAuthRouter } from '../modules/auth/auth.router.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { SessionService } from '../modules/auth/session.service.js';
import { createCvsRouter } from '../modules/cvs/cvs.router.js';
import { CvService } from '../modules/cvs/cv.service.js';
import { createHealthRouter } from '../modules/health/health.router.js';
import { DEFAULT_CREDENTIALS_RATE_LIMIT, type AppDeps, type AppOptions } from './deps.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createRequireAuth } from './middleware/require-auth.js';

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
  // router add its own routes on the same path:
  //   - part 2: POST /, POST /:id/retry, POST /:id/questions/:questionId/answer
  //   - part 3: GET /:id/pdf
  const cvs = Router();
  cvs.use(requireAuth);
  cvs.use(createCvsRouter({ cvService }));
  api.use('/cvs', cvs);

  return api;
}
