import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { browser, signedInUser, testConfig, useTestApp } from '../helpers/app.js';

const ctx = useTestApp();

describe('GET /api/health', () => {
  it('reports database and LLM status without authentication', async () => {
    const res = await supertest(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok', llm: 'fake' });
  });
});

describe('health with a real provider', () => {
  const anthropic = testConfig().llm;
  const withoutKey = useTestApp({}, { llm: { ...anthropic, provider: 'anthropic' } });
  const withKey = useTestApp(
    {},
    { llm: { ...anthropic, provider: 'anthropic', apiKey: 'sk-ant-test' } },
  );

  it('reports missing_key / configured', async () => {
    expect((await supertest(withoutKey.app).get('/api/health')).body.llm).toBe('missing_key');
    expect((await supertest(withKey.app).get('/api/health')).body.llm).toBe('configured');
  });
});

describe('HTTP hardening', () => {
  it('sets security headers, a request id and no-store caching', async () => {
    const res = await supertest(ctx.app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/^[\w-]+$/);
  });

  it('reuses a sane incoming request id but not an unsafe one', async () => {
    const reused = await supertest(ctx.app).get('/api/health').set('X-Request-Id', 'abc-123');
    expect(reused.headers['x-request-id']).toBe('abc-123');
    const replaced = await supertest(ctx.app).get('/api/health').set('X-Request-Id', 'a b\tc');
    expect(replaced.headers['x-request-id']).not.toBe('a b\tc');
  });

  it('answers unknown routes with 404 NOT_FOUND in the error shape', async () => {
    const res = await supertest(ctx.app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  it('maps a malformed percent-encoded path to 400, not 500', async () => {
    const { agent } = await signedInUser(ctx.app);
    const res = await agent.get('/api/cvs/%E0%A4%A');
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: expect.any(String),
      details: { issues: [{ path: '', message: 'Malformed URL encoding' }] },
    });
  });

  it('maps malformed JSON to 400 VALIDATION_ERROR', async () => {
    const res = await browser(ctx.app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: expect.any(String),
      details: { issues: [{ path: '', message: 'Malformed JSON body' }] },
    });
  });

  it('rejects JSON bodies over 1 MB', async () => {
    const { agent } = await signedInUser(ctx.app);
    const res = await agent
      .patch('/api/cvs/00000000-0000-4000-8000-000000000000')
      .send({ version: 1, title: 'x'.repeat(1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });
});
