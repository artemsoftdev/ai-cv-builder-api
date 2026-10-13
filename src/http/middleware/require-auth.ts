import type { RequestHandler } from 'express';
import {
  clearSessionCookie,
  hasSessionCookie,
  readSessionToken,
} from '../../modules/auth/session-cookie.js';
import type { SessionService } from '../../modules/auth/session.service.js';
import { unauthorized } from '../errors.js';

export function createRequireAuth(sessions: SessionService, cookieSecure: boolean): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionToken(req);
    const auth = token ? await sessions.authenticate(token) : null;
    if (!auth) {
      if (hasSessionCookie(req)) clearSessionCookie(res, cookieSecure);
      throw unauthorized();
    }
    req.auth = auth;
    next();
  };
}
