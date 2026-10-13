import type { RequestHandler } from 'express';
import {
  clearSessionCookie,
  hasSessionCookie,
  readSessionToken,
} from '../../modules/auth/session-cookie.js';
import type { SessionService } from '../../modules/auth/session.service.js';
import { unauthorized } from '../errors.js';

/** Loads the user from the session cookie; 401 UNAUTHORIZED when missing/invalid/expired. */
export function createRequireAuth(sessions: SessionService, cookieSecure: boolean): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionToken(req);
    const auth = token ? await sessions.authenticate(token) : null;
    if (!auth) {
      // Drop a stale cookie so the browser stops sending it.
      if (hasSessionCookie(req)) clearSessionCookie(res, cookieSecure);
      throw unauthorized();
    }
    req.auth = auth;
    next();
  };
}
