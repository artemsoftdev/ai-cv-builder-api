import type { Request } from 'express';
import type { AuthContext } from '../modules/auth/auth.types.js';
import { unauthorized } from './errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth; read it through getAuth(). */
    auth?: AuthContext;
  }
}

/** Auth context of a request that went through requireAuth. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
