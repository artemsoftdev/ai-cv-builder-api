import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { SessionEntity, UserEntity } from '../../src/db/entities/index.js';
import { hashSessionToken } from '../../src/modules/auth/session-token.js';
import {
  browser,
  DEFAULT_PASSWORD,
  signedInUser,
  uniqueEmail,
  useTestApp,
} from '../helpers/app.js';

const ctx = useTestApp();

function sessionCookie(setCookie: string[] | string | undefined): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return all.find((cookie) => cookie.startsWith('cvb_session='));
}

describe('POST /api/auth/signup', () => {
  it('creates the user, normalises the email and starts a session', async () => {
    const agent = browser(ctx.app);
    const res = await agent
      .post('/api/auth/signup')
      .send({ email: '  Jane.Doe@Example.COM ', password: DEFAULT_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      user: {
        id: expect.any(String),
        email: 'jane.doe@example.com',
        createdAt: expect.any(String),
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('scrypt');

    const cookie = sessionCookie(res.headers['set-cookie']);
    expect(cookie).toMatch(/^cvb_session=[\w-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(cookie).not.toContain('Secure');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual(res.body);
  });

  it('stores only a scrypt hash and a token hash', async () => {
    const res = await browser(ctx.app)
      .post('/api/auth/signup')
      .send({ email: 'hash@example.com', password: DEFAULT_PASSWORD });
    const token = sessionCookie(res.headers['set-cookie'])!.split(';')[0]!.split('=')[1]!;

    const user = await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({
      email: 'hash@example.com',
    });
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    const session = await ctx.dataSource.getRepository(SessionEntity).findOneByOrFail({
      userId: user.id,
    });
    expect(session.tokenHash).toBe(hashSessionToken(token));
    expect(session.tokenHash).not.toContain(token);
  });

  it('rejects a duplicate email regardless of case', async () => {
    await signedInUser(ctx.app, 'taken@example.com');
    const res = await browser(ctx.app)
      .post('/api/auth/signup')
      .send({ email: 'TAKEN@example.com', password: DEFAULT_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'EMAIL_TAKEN', message: expect.any(String) },
    });
  });

  it('validates email and password length', async () => {
    const res = await browser(ctx.app)
      .post('/api/auth/signup')
      .send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.issues).toEqual([
      { path: 'email', message: 'Enter a valid email address' },
      { path: 'password', message: 'Password must be at least 8 characters' },
    ]);

    const tooLong = await browser(ctx.app)
      .post('/api/auth/signup')
      .send({ email: uniqueEmail(), password: 'x'.repeat(129) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.details.issues[0].path).toBe('password');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with the right password (email is case-insensitive)', async () => {
    await signedInUser(ctx.app, 'login@example.com');
    const agent = browser(ctx.app);
    const res = await agent
      .post('/api/auth/login')
      .send({ email: 'Login@Example.com', password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('login@example.com');
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  it('rejects a wrong password and an unknown email the same way', async () => {
    await signedInUser(ctx.app, 'login@example.com');
    const wrongPassword = await browser(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: 'wrong password' });
    const unknownEmail = await browser(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: DEFAULT_PASSWORD });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(sessionCookie(res.headers['set-cookie'])).toBeUndefined();
    }
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('replaces the previous session of the same browser', async () => {
    const { agent, user } = await signedInUser(ctx.app, 'relogin@example.com');
    await agent.post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });
    const sessions = await ctx.dataSource.getRepository(SessionEntity).countBy({ userId: user.id });
    expect(sessions).toBe(1);
  });
});

describe('session lifecycle', () => {
  it('logout deletes the session and clears the cookie', async () => {
    const { agent, user } = await signedInUser(ctx.app);
    const res = await agent.post('/api/auth/logout');
    expect(res.status).toBe(204);
    expect(sessionCookie(res.headers['set-cookie'])).toMatch(
      /^cvb_session=;.*Expires=Thu, 01 Jan 1970/,
    );
    expect(await ctx.dataSource.getRepository(SessionEntity).countBy({ userId: user.id })).toBe(0);

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests without a session', async () => {
    const res = await supertest(ctx.app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('rejects a forged or malformed cookie', async () => {
    for (const value of ['garbage', 'a'.repeat(43)]) {
      const res = await supertest(ctx.app)
        .get('/api/auth/me')
        .set('Cookie', `cvb_session=${value}`);
      expect(res.status).toBe(401);
      // The stale cookie is cleared so the browser stops sending it.
      expect(sessionCookie(res.headers['set-cookie'])).toMatch(/^cvb_session=;/);
    }
  });

  it('rejects and deletes an expired session', async () => {
    const { agent, user } = await signedInUser(ctx.app);
    await ctx.dataSource.query(
      `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [user.id],
    );
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(await ctx.dataSource.getRepository(SessionEntity).countBy({ userId: user.id })).toBe(0);
  });

  it('deleting a user cascades to their sessions', async () => {
    const { user } = await signedInUser(ctx.app);
    await ctx.dataSource.getRepository(UserEntity).delete({ id: user.id });
    expect(await ctx.dataSource.getRepository(SessionEntity).countBy({ userId: user.id })).toBe(0);
  });
});

describe('CSRF protection', () => {
  it('rejects mutating requests without X-Requested-With', async () => {
    const res = await supertest(ctx.app)
      .post('/api/auth/signup')
      .send({ email: uniqueEmail(), password: DEFAULT_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'CSRF_CHECK_FAILED', message: expect.any(String) } });
    expect(await ctx.dataSource.getRepository(UserEntity).count()).toBe(0);
  });

  it('rejects a logout without the header even with a valid session cookie', async () => {
    const { agent } = await signedInUser(ctx.app);
    const res = await agent.post('/api/auth/logout').set('X-Requested-With', '');
    expect(res.status).toBe(403);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });
});

describe('rate limiting of signup + login', () => {
  const limited = useTestApp({ credentialsRateLimit: { limit: 3, windowMs: 60_000 } });

  it('answers 429 RATE_LIMITED with Retry-After once the shared budget is spent', async () => {
    const agent = browser(limited.app);
    const credentials = { email: uniqueEmail(), password: DEFAULT_PASSWORD };
    expect((await agent.post('/api/auth/signup').send(credentials)).status).toBe(201);
    expect((await agent.post('/api/auth/login').send(credentials)).status).toBe(200);
    expect((await agent.post('/api/auth/login').send(credentials)).status).toBe(200);

    const res = await agent.post('/api/auth/login').send(credentials);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);

    // Other routes are not limited.
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });
});

describe('rate limiting with the default TRUST_PROXY=false', () => {
  const limited = useTestApp(
    { credentialsRateLimit: { limit: 2, windowMs: 60_000 } },
    { trustProxy: false },
  );

  it('ignores a client-supplied X-Forwarded-For', async () => {
    const login = (ip: string) =>
      browser(limited.app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: uniqueEmail(), password: DEFAULT_PASSWORD });
    expect((await login('1.1.1.1')).status).toBe(401);
    expect((await login('2.2.2.2')).status).toBe(401);
    expect((await login('3.3.3.3')).status).toBe(429);
  });
});

describe('per-account rate limiting', () => {
  // trustProxy 'loopback' honours X-Forwarded-For, i.e. the client can rotate its apparent IP.
  const limited = useTestApp({ accountRateLimit: { limit: 2, windowMs: 60_000 } });

  it('caps failed attempts per email even when the client rotates its IP', async () => {
    const { user } = await signedInUser(limited.app);
    const attempt = (ip: string, password: string, email = user.email) =>
      browser(limited.app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password });

    expect((await attempt('1.1.1.1', 'wrong password 1')).status).toBe(401);
    expect((await attempt('2.2.2.2', 'wrong password 2')).status).toBe(401);
    const blocked = await attempt('3.3.3.3', DEFAULT_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // The same address differently cased or padded is the same account.
    expect(
      (await attempt('4.4.4.4', DEFAULT_PASSWORD, ` ${user.email.toUpperCase()}`)).status,
    ).toBe(429);
    // Other accounts are unaffected.
    expect((await attempt('3.3.3.3', 'wrong', uniqueEmail())).status).toBe(401);
  });

  it('does not count successful logins', async () => {
    const { user } = await signedInUser(limited.app);
    for (let i = 0; i < 4; i++) {
      const res = await browser(limited.app)
        .post('/api/auth/login')
        .send({ email: user.email, password: DEFAULT_PASSWORD });
      expect(res.status).toBe(200);
    }
  });
});
