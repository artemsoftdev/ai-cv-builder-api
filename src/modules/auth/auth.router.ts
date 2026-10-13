import { Router, type RequestHandler } from 'express';
import { getAuth } from '../../http/auth-context.js';
import { parseInput } from '../../http/validation.js';
import type { AuthService } from './auth.service.js';
import { loginBodySchema, signupBodySchema } from './auth.schemas.js';
import { toUserDto } from './auth.types.js';
import { clearSessionCookie, readSessionToken, setSessionCookie } from './session-cookie.js';
import type { SessionService } from './session.service.js';

export interface AuthRouterDeps {
  authService: AuthService;
  sessions: SessionService;
  requireAuth: RequestHandler;
  credentialsRateLimits: RequestHandler[];
  cookieSecure: boolean;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const { authService, sessions, requireAuth, credentialsRateLimits, cookieSecure } = deps;
  const router = Router();

  router.post('/signup', ...credentialsRateLimits, async (req, res) => {
    const credentials = parseInput(signupBodySchema, req.body);
    const previousToken = readSessionToken(req);
    const { user, session } = await authService.signup(credentials);
    if (previousToken) await sessions.revokeToken(previousToken);
    setSessionCookie(res, session.token, cookieSecure);
    res.status(201).json({ user: toUserDto(user) });
  });

  router.post('/login', ...credentialsRateLimits, async (req, res) => {
    const credentials = parseInput(loginBodySchema, req.body);
    const previousToken = readSessionToken(req);
    const { user, session } = await authService.login(credentials);
    // A re-login from the same browser replaces its session instead of adding one.
    if (previousToken) await sessions.revokeToken(previousToken);
    setSessionCookie(res, session.token, cookieSecure);
    res.status(200).json({ user: toUserDto(user) });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    await sessions.revoke(getAuth(req).sessionId);
    clearSessionCookie(res, cookieSecure);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: toUserDto(getAuth(req).user) });
  });

  return router;
}
