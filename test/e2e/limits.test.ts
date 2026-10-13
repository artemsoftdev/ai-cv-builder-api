import { describe, expect, it } from 'vitest';
import type { Response } from 'supertest';
import { browser, DEFAULT_PASSWORD, NO_LIMIT, signedInUser, type Browser } from '../helpers/app.js';
import { isSettled, pollCv, useE2eStack } from '../helpers/e2e.js';

const SOURCE = `Jane Doe
jane@example.com
Backend engineer with eight years of experience building payment systems in Go.
Software Engineer at Acme Payments (2019 - Present)
- Built the billing service in Go and PostgreSQL
Skills: Go, PostgreSQL`;

const create = (agent: Browser, text = SOURCE) =>
  agent.post('/api/cvs').field('targetRole', 'Backend Engineer').field('text', text);

function expectRateLimited(res: Response): void {
  expect(res.status).toBe(429);
  expect(res.body).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } });
  expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
}

describe('generation and answer budgets', () => {
  const stack = useE2eStack({
    generationRateLimit: { limit: 2, windowMs: 60_000 },
    answerRateLimit: { limit: 1, windowMs: 60_000 },
  });

  it('counts accepted generations only and answers 429 with Retry-After', async () => {
    const { agent } = await signedInUser(stack.app);
    expect((await create(agent, 'Too short.')).status).toBe(422);
    const first = await create(agent);
    expect(first.status).toBe(202);
    expect((await create(agent)).status).toBe(202);

    const over = await create(agent);
    expectRateLimited(over);
    expect(over.headers['ratelimit-policy']).toMatch(/q=2/);

    const { cv } = await pollCv(agent, first.body.cv.id as string, isSettled);
    const [question, other] = cv.questions;
    const answer = (id: string) =>
      agent.post(`/api/cvs/${cv.id}/questions/${id}/answer`).send({ answer: 'From 2019 to 2023' });
    expect((await answer(question!.id)).status).toBe(202);
    await pollCv(agent, cv.id, (c) => !c.busy);
    expectRateLimited(await answer(other!.id));
  });
});

describe('credential limits', () => {
  const stack = useE2eStack({
    credentialsRateLimit: NO_LIMIT,
    accountRateLimit: { limit: 2, windowMs: 60_000 },
  });

  it('locks an account after repeated failures, whichever client sends them', async () => {
    const { user } = await signedInUser(stack.app);
    const login = (password: string) =>
      browser(stack.app).post('/api/auth/login').send({ email: user.email, password });
    expect((await login('wrong 1')).status).toBe(401);
    expect((await login('wrong 2')).status).toBe(401);
    expectRateLimited(await login(DEFAULT_PASSWORD));
  });
});
