import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { CvDto } from '../../src/modules/cvs/cv.types.js';
import { browser, DEFAULT_PASSWORD, signedInUser, type Browser } from '../helpers/app.js';
import { getCv, isSettled, pollCv, useE2eStack } from '../helpers/e2e.js';

const stack = useE2eStack();

const SOURCE = `Jane Doe
jane@example.com
Backend engineer with eight years of experience building payment systems in Go.
Software Engineer at Acme Payments (2019 - Present)
- Built the billing service in Go and PostgreSQL
Skills: Go, PostgreSQL`;

async function readyCv(agent: Browser): Promise<CvDto> {
  const res = await agent
    .post('/api/cvs')
    .field('targetRole', 'Backend Engineer')
    .field('text', SOURCE);
  expect(res.status).toBe(202);
  return (await pollCv(agent, res.body.cv.id as string, isSettled)).cv;
}

describe('isolation between users', () => {
  it("answers 404 on every route for another user's CV and question", async () => {
    const alice = await signedInUser(stack.app);
    const bob = await signedInUser(stack.app);
    const cv = await readyCv(alice.agent);
    const question = cv.questions[0]!;
    const base = `/api/cvs/${cv.id}`;

    const responses = [
      await bob.agent.get(base),
      await bob.agent.get(`${base}/source`),
      await bob.agent.get(`${base}/pdf`),
      await bob.agent.patch(base).send({ version: cv.version, title: 'Hacked' }),
      await bob.agent.post(`${base}/retry`),
      await bob.agent.post(`${base}/questions/${question.id}/answer`).send({ answer: 'Hacked' }),
      await bob.agent.post(`${base}/questions/${question.id}/dismiss`),
      await bob.agent.delete(base),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    expect((await bob.agent.get('/api/cvs')).body.items).toEqual([]);
    expect(await getCv(alice.agent, cv.id)).toEqual(cv);
  });
});

describe('CSRF', () => {
  it('refuses state changes without X-Requested-With and changes nothing', async () => {
    const { agent } = await signedInUser(stack.app);
    const cv = await readyCv(agent);
    const noHeader = { 'X-Requested-With': '' };

    const responses = [
      await agent.post('/api/cvs').set(noHeader).field('targetRole', 'Dev').field('text', SOURCE),
      await agent
        .patch(`/api/cvs/${cv.id}`)
        .set(noHeader)
        .send({ version: cv.version, title: 'x' }),
      await agent.delete(`/api/cvs/${cv.id}`).set(noHeader),
      await agent
        .post(`/api/cvs/${cv.id}/questions/${cv.questions[0]!.id}/answer`)
        .set(noHeader)
        .send({ answer: 'x' }),
      await agent.post('/api/auth/logout').set(noHeader),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_CHECK_FAILED');
    }
    expect(await getCv(agent, cv.id)).toEqual(cv);
    expect((await agent.get('/api/cvs')).body.items).toHaveLength(1);
  });
});

describe('sessions', () => {
  it('keeps devices independent, and logout ends only its own session', async () => {
    const { agent: phone, user } = await signedInUser(stack.app);
    const laptop = browser(stack.app);
    await laptop.post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });

    expect((await phone.post('/api/auth/logout')).status).toBe(204);
    expect((await phone.get('/api/cvs')).status).toBe(401);
    expect((await laptop.get('/api/auth/me')).body.user.email).toBe(user.email);
  });

  it('expires a session after its lifetime and clears the cookie', async () => {
    const { agent, user } = await signedInUser(stack.app);
    await stack.dataSource.query(
      `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [user.id],
    );
    const expired = await agent.get('/api/cvs');
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('UNAUTHORIZED');
    expect(String(expired.headers['set-cookie'])).toMatch(/cvb_session=;/);

    const again = await agent
      .post('/api/auth/login')
      .send({ email: user.email, password: DEFAULT_PASSWORD });
    expect(again.status).toBe(200);
    expect((await agent.get('/api/cvs')).status).toBe(200);
  });

  it('rejects anonymous access and wrong passwords the same way for every account', async () => {
    const { user } = await signedInUser(stack.app);
    expect((await supertest(stack.app).get('/api/cvs')).status).toBe(401);
    const wrong = await browser(stack.app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'not the password' });
    const unknown = await browser(stack.app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: DEFAULT_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });
});
