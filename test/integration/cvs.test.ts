import supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { CvEntity, CvQuestionEntity, JobEntity } from '../../src/db/entities/index.js';
import type { CvDto } from '../../src/modules/cvs/cv.types.js';
import { sampleContent, sampleReview } from '../fixtures/cv-content.js';
import { signedInUser, useTestApp, type Browser } from '../helpers/app.js';
import { createCv, createJob, createQuestion } from '../helpers/fixtures.js';

const ctx = useTestApp();

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let alice: { agent: Browser; userId: string };
let bob: { agent: Browser; userId: string };

beforeEach(async () => {
  const a = await signedInUser(ctx.app, 'alice@example.com');
  const b = await signedInUser(ctx.app, 'bob@example.com');
  alice = { agent: a.agent, userId: a.user.id };
  bob = { agent: b.agent, userId: b.user.id };
});

async function getCv(agent: Browser, id: string): Promise<CvDto> {
  const res = await agent.get(`/api/cvs/${id}`);
  expect(res.status).toBe(200);
  return (res.body as { cv: CvDto }).cv;
}

describe('GET /api/cvs', () => {
  it('lists only my CVs, newest first, with busy and openQuestions', async () => {
    const older = await createCv(ctx.dataSource, alice.userId, { title: 'Older' });
    await ctx.dataSource.query(
      `UPDATE cvs SET created_at = now() - interval '1 day' WHERE id = $1`,
      [older.id],
    );
    const newer = await createCv(ctx.dataSource, alice.userId, {
      title: 'Newer',
      status: 'generating',
      stage: 'drafting',
      content: null,
      review: null,
    });
    await createJob(ctx.dataSource, newer.id, { status: 'running' });
    await createQuestion(ctx.dataSource, older.id, { status: 'open' });
    await createQuestion(ctx.dataSource, older.id, { status: 'failed', error: 'LLM_UNAVAILABLE' });
    await createQuestion(ctx.dataSource, older.id, { status: 'applied', answer: 'Five people' });
    await createCv(ctx.dataSource, bob.userId, { title: 'Bob CV' });

    const res = await alice.agent.get('/api/cvs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          id: newer.id,
          title: 'Newer',
          targetRole: 'Senior Backend Engineer',
          status: 'generating',
          stage: 'drafting',
          busy: true,
          openQuestions: 0,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        expect.objectContaining({ id: older.id, title: 'Older', busy: false, openQuestions: 2 }),
      ],
    });
  });

  it('requires a session', async () => {
    expect((await supertest(ctx.app).get('/api/cvs')).status).toBe(401);
  });
});

describe('GET /api/cvs/:id', () => {
  it('returns the full CV with ordered questions and no source data', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId, {
      sourceFilename: 'jane.pdf',
      sourceType: 'pdf',
    });
    const second = await createQuestion(ctx.dataSource, cv.id, {
      position: 2,
      question: 'Second?',
    });
    const first = await createQuestion(ctx.dataSource, cv.id, {
      position: 1,
      section: 'summary',
      itemId: null,
      question: 'First?',
    });

    const res = await alice.agent.get(`/api/cvs/${cv.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cv: {
        id: cv.id,
        title: 'Senior Backend Engineer CV',
        targetRole: 'Senior Backend Engineer',
        sourceType: 'pdf',
        sourceFilename: 'jane.pdf',
        status: 'ready',
        stage: 'done',
        error: null,
        content: sampleContent(),
        review: sampleReview(),
        questions: [
          {
            id: first.id,
            section: 'summary',
            itemId: null,
            question: 'First?',
            answer: null,
            status: 'open',
            error: null,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
          expect.objectContaining({ id: second.id, question: 'Second?', itemId: 'exp-1' }),
        ],
        version: 1,
        busy: false,
        createdAt: cv.createdAt.toISOString(),
        updatedAt: cv.updatedAt.toISOString(),
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('Backend engineer at Acme Payments since');
  });

  it('exposes the failure of a failed generation', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId, {
      status: 'failed',
      stage: 'drafting',
      content: null,
      review: null,
      errorCode: 'LLM_UNAVAILABLE',
      errorMessage: 'Claude is temporarily unavailable.',
    });
    const dto = await getCv(alice.agent, cv.id);
    expect(dto.error).toEqual({
      code: 'LLM_UNAVAILABLE',
      message: 'Claude is temporarily unavailable.',
    });
    expect(dto.content).toBeNull();
  });

  it('answers 400 for a malformed id and 404 for a missing one', async () => {
    const malformed = await alice.agent.get('/api/cvs/not-a-uuid');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.details.issues).toEqual([{ path: 'id', message: 'Invalid CV id' }]);

    const missing = await alice.agent.get(`/api/cvs/${MISSING_ID}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });
});

describe('ownership isolation', () => {
  it("hides another user's CV behind 404 on every route", async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const question = await createQuestion(ctx.dataSource, cv.id);

    const responses = [
      await bob.agent.get(`/api/cvs/${cv.id}`),
      await bob.agent.patch(`/api/cvs/${cv.id}`).send({ version: 1, title: 'Hacked' }),
      await bob.agent.delete(`/api/cvs/${cv.id}`),
      await bob.agent.post(`/api/cvs/${cv.id}/questions/${question.id}/dismiss`),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    expect((await bob.agent.get('/api/cvs')).body).toEqual({ items: [] });

    // Nothing changed for the owner.
    const dto = await getCv(alice.agent, cv.id);
    expect(dto.title).toBe('Senior Backend Engineer CV');
    expect(dto.version).toBe(1);
    expect(dto.questions[0]!.status).toBe('open');
  });
});

describe('PATCH /api/cvs/:id', () => {
  it('updates the title and bumps the version', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const res = await alice.agent
      .patch(`/api/cvs/${cv.id}`)
      .send({ version: 1, title: '  Backend CV  ' });
    expect(res.status).toBe(200);
    expect(res.body.cv.title).toBe('Backend CV');
    expect(res.body.cv.version).toBe(2);
    expect(Date.parse(res.body.cv.updatedAt)).toBeGreaterThan(cv.updatedAt.getTime());
  });

  it('does not bump the version for a no-op save', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const res = await alice.agent
      .patch(`/api/cvs/${cv.id}`)
      .send({ version: 1, title: cv.title, content: sampleContent() });
    expect(res.status).toBe(200);
    expect(res.body.cv.version).toBe(1);
  });

  it('saves sanitised content and prunes flags of edited items', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const content = sampleContent();
    content.experience[0]!.bullets[1]!.text = '  Cut p99 latency of the API.  ';
    const res = await alice.agent.patch(`/api/cvs/${cv.id}`).send({ version: 1, content });

    expect(res.status).toBe(200);
    const dto = res.body.cv as CvDto;
    expect(dto.version).toBe(2);
    expect(dto.content!.experience[0]!.bullets[1]!.text).toBe('Cut p99 latency of the API.');
    expect(dto.review!.flags.map((flag) => flag.id)).toEqual(['flag-exp', 'flag-summary']);
    expect(dto.review!.removed).toEqual(sampleReview().removed);
  });

  it('dismisses flags', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const res = await alice.agent
      .patch(`/api/cvs/${cv.id}`)
      .send({ version: 1, dismissFlagIds: ['flag-exp', 'flag-summary'] });
    expect(res.status).toBe(200);
    expect(res.body.cv.review.flags.map((flag: { id: string }) => flag.id)).toEqual([
      'flag-bullet',
    ]);
    expect(res.body.cv.version).toBe(2);
  });

  it('rejects a stale version with 409 VERSION_CONFLICT and the current version', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    await alice.agent.patch(`/api/cvs/${cv.id}`).send({ version: 1, title: 'From laptop' });

    const res = await alice.agent
      .patch(`/api/cvs/${cv.id}`)
      .send({ version: 1, title: 'From phone' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'VERSION_CONFLICT',
        message: expect.any(String),
        details: { currentVersion: 2 },
      },
    });
    expect((await getCv(alice.agent, cv.id)).title).toBe('From laptop');
  });

  it('lets exactly one of two concurrent saves with the same version win', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const results = await Promise.all(
      ['A', 'B', 'C', 'D'].map((title) =>
        alice.agent.patch(`/api/cvs/${cv.id}`).send({ version: 1, title }),
      ),
    );
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    expect((await getCv(alice.agent, cv.id)).version).toBe(2);
  });

  it('rejects edits with 409 CV_BUSY while a job is queued or running', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const question = await createQuestion(ctx.dataSource, cv.id, {
      status: 'applying',
      answer: 'Five',
    });
    const job = await createJob(ctx.dataSource, cv.id, {
      type: 'apply_answer',
      questionId: question.id,
      status: 'queued',
    });

    expect((await getCv(alice.agent, cv.id)).busy).toBe(true);
    const res = await alice.agent.patch(`/api/cvs/${cv.id}`).send({ version: 1, title: 'Edited' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CV_BUSY');

    await ctx.dataSource.getRepository(JobEntity).update({ id: job.id }, { status: 'succeeded' });
    const after = await alice.agent
      .patch(`/api/cvs/${cv.id}`)
      .send({ version: 1, title: 'Edited' });
    expect(after.status).toBe(200);
    expect(after.body.cv.busy).toBe(false);
  });

  it('rejects content edits on a CV without generated content', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId, {
      status: 'failed',
      stage: 'drafting',
      content: null,
      review: null,
      errorCode: 'LLM_REFUSED',
      errorMessage: 'Refused',
    });
    const res = await alice.agent
      .patch(`/api/cvs/${cv.id}`)
      .send({ version: 1, content: sampleContent() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CV_NOT_READY');

    // The title can still be changed.
    const titled = await alice.agent
      .patch(`/api/cvs/${cv.id}`)
      .send({ version: 1, title: 'Retry later' });
    expect(titled.status).toBe(200);
  });

  it('reports every validation issue with its path', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const content = sampleContent();
    content.experience[0]!.bullets[0]!.text = 'x'.repeat(401);
    content.contact.links[0]!.url = 'javascript:alert(1)';
    const res = await alice.agent
      .patch(`/api/cvs/${cv.id}`)
      .send({ version: 'one', title: '   ', content });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.issues.map((issue: { path: string }) => issue.path)).toEqual([
      'version',
      'title',
      'content.contact.links.0.url',
      'content.experience.0.bullets.0.text',
    ]);
    expect((await getCv(alice.agent, cv.id)).version).toBe(1);
  });

  it('requires the CSRF header', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const res = await alice.agent
      .patch(`/api/cvs/${cv.id}`)
      .set('X-Requested-With', '')
      .send({ version: 1, title: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_CHECK_FAILED');
  });
});

describe('DELETE /api/cvs/:id', () => {
  it('deletes the CV with its questions and jobs', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    await createQuestion(ctx.dataSource, cv.id);
    await createJob(ctx.dataSource, cv.id, { status: 'running' });

    expect((await alice.agent.delete(`/api/cvs/${cv.id}`)).status).toBe(204);
    expect((await alice.agent.get(`/api/cvs/${cv.id}`)).status).toBe(404);
    expect((await alice.agent.delete(`/api/cvs/${cv.id}`)).status).toBe(404);
    expect(await ctx.dataSource.getRepository(CvEntity).countBy({ id: cv.id })).toBe(0);
    expect(await ctx.dataSource.getRepository(CvQuestionEntity).countBy({ cvId: cv.id })).toBe(0);
    expect(await ctx.dataSource.getRepository(JobEntity).countBy({ cvId: cv.id })).toBe(0);
  });
});

describe('DELETE while a job completes', () => {
  async function waitForLockWait(): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const [row] = await ctx.dataSource.query<{ waiting: number }[]>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      if ((row?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error('DELETE never waited for the job lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('waits for the completing transaction instead of deadlocking with it', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const job = await createJob(ctx.dataSource, cv.id, { status: 'running' });
    const completing = ctx.dataSource.createQueryRunner();
    await completing.connect();
    try {
      // Same lock order as JobWorker.complete(): the job row first, then the CV row.
      await completing.startTransaction();
      await completing.query(`UPDATE jobs SET status = 'succeeded' WHERE id = $1`, [job.id]);
      const deleting = alice.agent.delete(`/api/cvs/${cv.id}`).then((res) => res);
      await waitForLockWait();
      await completing.query(`UPDATE cvs SET updated_at = now() WHERE id = $1`, [cv.id]);
      await completing.commitTransaction();
      expect((await deleting).status).toBe(204);
    } finally {
      if (completing.isTransactionActive) await completing.rollbackTransaction();
      await completing.release();
    }
    expect(await ctx.dataSource.getRepository(CvEntity).countBy({ id: cv.id })).toBe(0);
  });
});

describe('POST /api/cvs/:id/questions/:questionId/dismiss', () => {
  it.each(['open', 'failed'] as const)('dismisses a %s question', async (status) => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const question = await createQuestion(ctx.dataSource, cv.id, {
      status,
      error: status === 'failed' ? 'LLM_UNAVAILABLE' : null,
    });

    const res = await alice.agent.post(`/api/cvs/${cv.id}/questions/${question.id}/dismiss`);
    expect(res.status).toBe(200);
    expect(res.body.cv.questions).toEqual([
      expect.objectContaining({ id: question.id, status: 'dismissed', error: null }),
    ]);
    expect(res.body.cv.version).toBe(1);

    const list = await alice.agent.get('/api/cvs');
    expect(list.body.items[0].openQuestions).toBe(0);
  });

  it.each(['applying', 'applied', 'dismissed'] as const)(
    'rejects dismissing an %s question with 409 INVALID_STATE',
    async (status) => {
      const cv = await createCv(ctx.dataSource, alice.userId);
      const question = await createQuestion(ctx.dataSource, cv.id, { status });
      const res = await alice.agent.post(`/api/cvs/${cv.id}/questions/${question.id}/dismiss`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
    },
  );

  it('answers 404 for a question of another CV', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    const otherCv = await createCv(ctx.dataSource, alice.userId);
    const question = await createQuestion(ctx.dataSource, otherCv.id);
    const res = await alice.agent.post(`/api/cvs/${cv.id}/questions/${question.id}/dismiss`);
    expect(res.status).toBe(404);
    expect((await getCv(alice.agent, otherCv.id)).questions[0]!.status).toBe('open');
  });
});

describe('database invariants', () => {
  it('allows at most one live job per CV', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    await createJob(ctx.dataSource, cv.id, { status: 'running' });
    await expect(createJob(ctx.dataSource, cv.id, { status: 'queued' })).rejects.toThrow(
      /jobs_one_active_per_cv_uidx/,
    );
    // Finished jobs do not count.
    await createJob(ctx.dataSource, cv.id, { status: 'failed' });
  });

  it('rejects unknown enum values', async () => {
    const cv = await createCv(ctx.dataSource, alice.userId);
    await expect(
      ctx.dataSource.query(`UPDATE cvs SET status = 'done' WHERE id = $1`, [cv.id]),
    ).rejects.toThrow(/cvs_status_chk/);
  });
});
