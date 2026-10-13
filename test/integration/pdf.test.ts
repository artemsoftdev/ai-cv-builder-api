import supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { sampleContent } from '../fixtures/cv-content.js';
import { signedInUser, useTestApp, type Browser } from '../helpers/app.js';
import { createCv, createJob } from '../fixtures/db-rows.js';
import { inspectPdf } from '../helpers/pdf-inspect.js';

const ctx = useTestApp({ pdfRateLimit: { limit: 3, windowMs: 60_000 } });

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let alice: { agent: Browser; userId: string };

beforeEach(async () => {
  const { agent, user } = await signedInUser(ctx.app);
  alice = { agent, userId: user.id };
});

function downloadPdf(agent: Browser, cvId: string) {
  return agent
    .get(`/api/cvs/${cvId}/pdf`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

describe('GET /api/cvs/:id/pdf', () => {
  it('returns the CV as an A4 PDF attachment', async () => {
    const content = sampleContent();
    content.contact.fullName = 'Jane Doe';
    const cv = await createCv(ctx.dataSource, alice.userId, { title: 'Backend CV', content });

    const res = await downloadPdf(alice.agent, cv.id);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Jane Doe - Backend CV.pdf"; filename*=UTF-8''Jane%20Doe%20-%20Backend%20CV.pdf`,
    );
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Number(res.headers['content-length'])).toBe(pdf.length);

    const doc = await inspectPdf(pdf);
    expect(doc.pageSizes).toEqual([
      { width: expect.closeTo(595.28, 1), height: expect.closeTo(841.89, 1) },
    ]);
    expect(doc.title).toBe('Backend CV');
    expect(doc.text).toContain('Jane Doe');
    expect(doc.text).toContain('Built the billing service in Go.');
  });

  it('exports the current content while a job is running', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    await createJob(ctx.dataSource, cv.id, { status: 'running' });
    expect((await downloadPdf(alice.agent, cv.id)).status).toBe(200);
  });

  it("answers 404 for another user's CV and for unknown ids", async () => {
    const bob = await signedInUser(ctx.app);
    const bobsCv = await createCv(ctx.dataSource, bob.user.id);

    for (const id of [bobsCv.id, MISSING_ID]) {
      const res = await alice.agent.get(`/api/cvs/${id}/pdf`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'CV not found' } });
    }
  });

  it('answers 409 CV_NOT_READY while there is no content', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId, {
      status: 'generating',
      stage: 'drafting',
      content: null,
      review: null,
    });
    const res = await alice.agent.get(`/api/cvs/${cv.id}/pdf`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CV_NOT_READY');
  });

  it('validates the id and requires a session', async () => {
    const res = await alice.agent.get('/api/cvs/not-a-uuid/pdf');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const anonymous = await supertest(ctx.app).get(`/api/cvs/${MISSING_ID}/pdf`);
    expect(anonymous.status).toBe(401);
  });

  it('rate-limits exports per user', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    for (let i = 0; i < 3; i++) expect((await downloadPdf(alice.agent, cv.id)).status).toBe(200);

    const limited = await alice.agent.get(`/api/cvs/${cv.id}/pdf`);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    const bob = await signedInUser(ctx.app);
    const bobsCv = await createCv(ctx.dataSource, bob.user.id);
    expect((await downloadPdf(bob.agent, bobsCv.id)).status).toBe(200);
  });
});
