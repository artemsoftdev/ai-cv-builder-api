import type { CookieOptions, Request, Response } from 'express';
import { isWellFormedSessionToken, SESSION_TTL_MS } from './session-token.js';

export const SESSION_COOKIE = 'cvb_session';

function cookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure };
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(secure), maxAge: SESSION_TTL_MS });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(secure));
}

export function readSessionToken(req: Request): string | null {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[SESSION_COOKIE];
  return typeof value === 'string' && isWellFormedSessionToken(value) ? value : null;
}

export function hasSessionCookie(req: Request): boolean {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  return cookies?.[SESSION_COOKIE] !== undefined;
}
