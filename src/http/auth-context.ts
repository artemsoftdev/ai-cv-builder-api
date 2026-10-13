import type { Request } from 'express';
import type { AuthContext } from '../modules/auth/auth.types.js';
import { unauthorized } from './errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
