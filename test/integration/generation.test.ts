import supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CvDto } from '../../src/modules/cvs/cv.types.js';
import type { DraftCv } from '../../src/modules/generation/llm-output.schemas.js';
import { REASONS } from '../../src/modules/grounding/verifier.js';
import { PermanentError } from '../../src/modules/jobs/job-errors.js';
import type { JobWorker } from '../../src/modules/jobs/worker.js';
import { FakeLlmClient } from '../../src/modules/llm/fake-llm-client.js';
import { FAKE_TRANSCRIPTION } from '../../src/modules/llm/fake-heuristics.js';
import { NO_LIMIT, signedInUser, useTestApp, type Browser } from '../helpers/app.js';
import { createCv, createJob, createQuestion } from '../helpers/fixtures.js';
import { makePdf, makeScannedPdf } from '../helpers/pdf.js';
import { createTestWorker } from '../helpers/worker.js';

const ctx = useTestApp({ generationRateLimit: NO_LIMIT, answerRateLimit: NO_LIMIT });

const SOURCE = `Jane Doe
jane@example.com
Backend engineer with eight years of experience building payment systems in Go.
Software Engineer at Acme Payments
- Built the billing service in Go and PostgreSQL
- Reduced p99 latency from 200ms to 120ms
TU Berlin, BSc Computer Science
Skills: Go, PostgreSQL, Kafka`;

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let me: { agent: Browser; userId: string };
let llm: FakeLlmClient;
let worker: JobWorker;

beforeEach(async () => {
  const { agent, user } = await signedInUser(ctx.app);
  me = { agent, userId: user.id };
  llm = new FakeLlmClient();
  worker = createTestWorker(ctx.dataSource, { llm });
});

function postText(agent: Browser, text: string, targetRole = 'Senior Backend Engineer') {
  return agent.post('/api/cvs').field('targetRole', targetRole).field('text', text);
}

function postPdf(
  agent: Browser,
  pdf: Buffer,
  filename = 'cv.pdf',
  targetRole = 'Backend Engineer',
) {
  return agent
    .post('/api/cvs')
    .field('targetRole', targetRole)
    .attach('file', pdf, { filename, contentType: 'application/pdf' });
}

async function getCv(id: string): Promise<CvDto> {
  const res = await me.agent.get(`/api/cvs/${id}`);
  expect(res.status).toBe(200);
  return (res.body as { cv: CvDto }).cv;
}

async function generatedCv(text = SOURCE): Promise<CvDto> {
  const res = await postText(me.agent, text);
  expect(res.status).toBe(202);
  await worker.drain();
  return getCv((res.body as { cv: CvDto }).cv.id);
}

async function sourceColumns(id: string) {
  const [row] = await ctx.dataSource.query<{ sourceText: string | null; hasPdf: boolean }[]>(
    `SELECT source_text AS "sourceText", source_pdf IS NOT NULL AS "hasPdf" FROM cvs WHERE id = $1`,
    [id],
  );
  return row!;
}

describe('POST /api/cvs with text', () => {
  it('accepts the source, then the worker turns it into a ready CV', async () => {
    const res = await postText(me.agent, SOURCE);
    expect(res.status).toBe(202);
    const accepted = (res.body as { cv: CvDto }).cv;
    expect(accepted).toMatchObject({
      title: 'Senior Backend Engineer',
      targetRole: 'Senior Backend Engineer',
      sourceType: 'text',
      sourceFilename: null,
      status: 'generating',
      stage: 'queued',
      content: null,
      busy: true,
      version: 1,
    });

    expect(await worker.drain()).toBe(1);
    const cv = await getCv(accepted.id);
    expect(cv).toMatchObject({ status: 'ready', stage: 'done', busy: false, version: 2 });
    expect(cv.content?.contact).toMatchObject({ fullName: 'Jane Doe', email: 'jane@example.com' });
    expect(cv.content?.experience[0]).toMatchObject({
      company: 'Acme Payments',
      title: 'Software Engineer',
    });
    expect(cv.review?.flags).toEqual([]);
    expect(Object.keys(cv.review?.evidence ?? {})).toContain('summary');
    expect(cv.questions.length).toBeGreaterThan(0);
    expect(cv.questions.every((q) => q.status === 'open')).toBe(true);
    // The source is stored normalised but never returned.
    expect(JSON.stringify(cv)).not.toContain('Built the billing service in Go and PostgreSQL\n');
  });

  it('flags invented numbers and removes invented contact data and skills', async () => {
    const draft: DraftCv = {
      contact: {
        fullName: 'Jane Doe',
        headline: 'Backend Engineer',
        email: 'jane.doe@gmail.com',
        phone: '',
        location: '',
        links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/janedoe' }],
      },
      summary: { text: 'Backend engineer with 10 years in payments.', evidence: ['eight years'] },
      experience: [
        {
          company: 'Acme Payments',
          title: 'Senior Software Engineer',
          location: '',
          startDate: '',
          endDate: '',
          relevance: 90,
          bullets: [
            { text: 'Built the billing service in Go', evidence: ['Built the billing service'] },
            { text: 'Cut p99 latency by 40%', evidence: ['Reduced p99 latency'] },
            { text: 'Led a team of 12 engineers', evidence: ['led a team of 12'] },
            { text: 'Ran the billing service on Kubernetes', evidence: ['the billing service'] },
          ],
        },
      ],
      education: [],
      skills: [{ name: 'Tech', items: ['Go', 'Kubernetes', 'PostgreSQL'] }],
      questions: [
        { section: 'experience', itemIndex: 0, question: 'When did you join Acme Payments?' },
      ],
    };
    llm.overrides.draftCv = () => draft;
    const cv = await generatedCv();

    const exp = cv.content!.experience[0]!;
    const flags = (itemId: string) =>
      cv.review!.flags.filter((f) => f.itemId === itemId).map((f) => f.reason);
    expect(flags('summary')).toEqual([REASONS.number('10')]);
    expect(flags(exp.id)).toEqual([REASONS.seniority('senior')]);
    expect(flags(exp.bullets[0]!.id)).toEqual([]);
    expect(flags(exp.bullets[1]!.id)).toEqual([REASONS.number('40')]);
    expect(flags(exp.bullets[2]!.id)).toEqual([
      REASONS.noEvidence,
      REASONS.number('12'),
      REASONS.ownership('led'),
    ]);
    expect(flags(exp.bullets[3]!.id)).toEqual([REASONS.terms(['Kubernetes'])]);

    expect(cv.content!.contact.email).toBe('');
    expect(cv.content!.contact.links).toEqual([]);
    expect(cv.content!.skills[0]!.items).toEqual(['Go', 'PostgreSQL']);
    expect(cv.review!.removed.map((r) => [r.field, r.value])).toEqual([
      ['contact.email', 'jane.doe@gmail.com'],
      ['contact.links', 'https://linkedin.com/in/janedoe'],
      ['skills', 'Kubernetes'],
    ]);
    expect(cv.review!.evidence[exp.bullets[0]!.id]).toEqual(['Built the billing service']);
    expect(cv.questions).toEqual([
      expect.objectContaining({ section: 'experience', itemId: exp.id, status: 'open' }),
    ]);
  });

  it('validates the form', async () => {
    const neither = await me.agent.post('/api/cvs').field('targetRole', 'Dev');
    expect(neither.status).toBe(400);
    expect(neither.body.error.code).toBe('VALIDATION_ERROR');

    const both = await me.agent
      .post('/api/cvs')
      .field('targetRole', 'Dev')
      .field('text', SOURCE)
      .attach('file', await makePdf([['Jane Doe']]), 'cv.pdf');
    expect(both.status).toBe(400);

    const noRole = await me.agent.post('/api/cvs').field('text', SOURCE);
    expect(noRole.status).toBe(400);
    expect(noRole.body.error.details.issues).toEqual([
      expect.objectContaining({ path: 'targetRole' }),
    ]);

    const longRole = await postText(me.agent, SOURCE, 'x'.repeat(121));
    expect(longRole.status).toBe(400);

    const json = await me.agent.post('/api/cvs').send({ targetRole: 'Dev', text: SOURCE });
    expect(json.status).toBe(400);

    const unexpectedFile = await me.agent
      .post('/api/cvs')
      .field('targetRole', 'Dev')
      .attach('photo', Buffer.from('%PDF-1.7'), 'a.pdf');
    expect(unexpectedFile.status).toBe(400);
  });

  it('rejects text that is too short or too long with 422', async () => {
    const short = await postText(me.agent, 'Jane Doe, engineer.');
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('UNPROCESSABLE_SOURCE');

    const long = await postText(me.agent, 'word '.repeat(4_100));
    expect(long.status).toBe(422);
  });

  it('requires a session and the CSRF header', async () => {
    const anonymous = supertest(ctx.app);
    const res = await anonymous
      .post('/api/cvs')
      .set('X-Requested-With', 'XMLHttpRequest')
      .field('targetRole', 'Dev')
      .field('text', SOURCE);
    expect(res.status).toBe(401);
    const noHeader = await anonymous.post('/api/cvs').field('targetRole', 'Dev');
    expect(noHeader.status).toBe(403);
  });

  it('allows at most 3 CVs generating at once per user', async () => {
    for (let i = 0; i < 3; i++) expect((await postText(me.agent, SOURCE)).status).toBe(202);
    const fourth = await postText(me.agent, SOURCE);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('RATE_LIMITED');
    expect(fourth.headers['retry-after']).toBe('30');

    // Other users are not affected.
    const other = await signedInUser(ctx.app);
    expect((await postText(other.agent, SOURCE)).status).toBe(202);

    await worker.drain();
    expect((await postText(me.agent, SOURCE)).status).toBe(202);
  });
});

describe('generation budget', () => {
  const limited = useTestApp({ generationRateLimit: { limit: 2, windowMs: 60_000 } });

  it('counts only accepted starts, shared by create and retry', async () => {
    const { agent, user } = await signedInUser(limited.app);
    expect((await postText(agent, 'Too short.')).status).toBe(422);
    expect((await postText(agent, 'Still too short.')).status).toBe(422);
    expect((await postText(agent, SOURCE)).status).toBe(202);

    const failed = await createCv(limited.dataSource, user.id, {
      status: 'failed',
      content: null,
      review: null,
      errorCode: 'LLM_UNAVAILABLE',
    });
    expect((await agent.post(`/api/cvs/${failed.id}/retry`)).status).toBe(202);

    const over = await postText(agent, SOURCE);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('deployment-wide job cap', () => {
  const capped = useTestApp({ maxLiveJobs: 1 });

  it('refuses new work while the queue is full, for every user', async () => {
    const first = await signedInUser(capped.app);
    const second = await signedInUser(capped.app);
    expect((await postText(first.agent, SOURCE)).status).toBe(202);

    const refused = await postText(second.agent, SOURCE);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toEqual({ code: 'RATE_LIMITED', message: expect.any(String) });
    expect(refused.headers['retry-after']).toBe('60');

    await createTestWorker(capped.dataSource).drain();
    expect((await postText(second.agent, SOURCE)).status).toBe(202);
  });
});

describe('POST /api/cvs with a PDF', () => {
  it('extracts the text layer, keeps a safe file name and appends hidden link targets', async () => {
    const pdf = await makePdf([SOURCE.split('\n')], {
      hiddenLinkUrl: 'https://github.com/janedoe',
    });
    const res = await postPdf(me.agent, pdf, '../../Jane CV.pdf');
    expect(res.status).toBe(202);
    const accepted = (res.body as { cv: CvDto }).cv;
    expect(accepted).toMatchObject({ sourceType: 'pdf', sourceFilename: 'Jane CV.pdf' });

    const stored = await sourceColumns(accepted.id);
    expect(stored.hasPdf).toBe(false);
    expect(stored.sourceText).toContain('Software Engineer at Acme Payments');
    expect(stored.sourceText).toMatch(/Links:\nhttps:\/\/github\.com\/janedoe$/);

    await worker.drain();
    const cv = await getCv(accepted.id);
    expect(cv.status).toBe('ready');
    // The link came from the annotation, so it survives verification.
    expect(cv.content!.contact.links.map((l) => l.url)).toEqual(['https://github.com/janedoe']);
  });

  it('handles Cyrillic PDFs end to end', async () => {
    const lines = [
      'Иван Петров',
      'ivan@example.com',
      'Бэкенд-разработчик с опытом создания платёжных систем на Go и PostgreSQL.',
      'Разработчик at ООО Ромашка (2018 - 2022)',
      '- Разработал сервис биллинга на Go',
      '- Перевёл отчёты компании с MySQL на PostgreSQL',
      'Skills: Go, PostgreSQL, Docker',
    ];
    const res = await postPdf(me.agent, await makePdf([lines], { unicode: true }), 'Резюме.pdf');
    expect(res.status).toBe(202);
    expect(res.body.cv.sourceFilename).toBe('Резюме.pdf');
    await worker.drain();
    const cv = await getCv(res.body.cv.id);
    expect(cv.status).toBe('ready');
    expect(cv.content!.contact.fullName).toBe('Иван Петров');
    expect(cv.content!.experience[0]).toMatchObject({ company: 'ООО Ромашка', startDate: '2018' });
    expect(cv.content!.experience[0]!.bullets[0]!.text).toBe('Разработал сервис биллинга на Go');
    expect(cv.review!.flags).toEqual([]);
  });

  it('stores a scanned PDF and has it transcribed in the extracting stage', async () => {
    let stageDuringTranscription: string | undefined;
    llm.overrides.transcribePdf = async () => {
      const [row] = await ctx.dataSource.query<{ stage: string }[]>(`SELECT stage FROM cvs`);
      stageDuringTranscription = row?.stage;
      return FAKE_TRANSCRIPTION;
    };
    const res = await postPdf(me.agent, await makeScannedPdf());
    expect(res.status).toBe(202);
    expect(await sourceColumns(res.body.cv.id)).toEqual({ sourceText: null, hasPdf: true });

    await worker.drain();
    expect(stageDuringTranscription).toBe('extracting');
    expect(llm.calls.transcribePdf).toBe(1);
    const stored = await sourceColumns(res.body.cv.id);
    expect(stored.hasPdf).toBe(false);
    expect(stored.sourceText).toContain('Alex Example');
    expect((await getCv(res.body.cv.id)).status).toBe('ready');
    const source = await me.agent.get(`/api/cvs/${res.body.cv.id}/source`);
    expect(source.body.source).toMatchObject({ type: 'pdf', transcribed: true });
    expect(source.body.source.text).toContain('Alex Example');
  });

  it('fails the CV with SOURCE_UNREADABLE when the scan has no legible text', async () => {
    llm.overrides.transcribePdf = () => 'NO_READABLE_TEXT';
    const res = await postPdf(me.agent, await makeScannedPdf());
    await worker.drain();
    const cv = await getCv(res.body.cv.id);
    expect(cv.status).toBe('failed');
    expect(cv.error?.code).toBe('SOURCE_UNREADABLE');
  });

  it('rejects files that are not PDFs by their bytes, whatever the name', async () => {
    const res = await postPdf(me.agent, Buffer.from('PK\u0003\u0004 not a pdf'), 'cv.pdf');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE');
  });

  it('rejects files over 5 MB with 413', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(5 * 1024 * 1024)]);
    const res = await postPdf(me.agent, big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects damaged PDFs and PDFs with more than 10 pages with 422', async () => {
    const damaged = await postPdf(me.agent, Buffer.from('%PDF-1.7\ngarbage'));
    expect(damaged.status).toBe(422);
    expect(damaged.body.error.message).toMatch(/damaged/);

    const pages = Array.from({ length: 11 }, (_, i) => [`Page ${i + 1}`]);
    const long = await postPdf(me.agent, await makePdf(pages));
    expect(long.status).toBe(422);
    expect(long.body.error.message).toContain('11 pages');
  });
});

describe('POST /api/cvs/:id/retry', () => {
  it('restarts a failed generation with a fresh job', async () => {
    llm.overrides.draftCv = () => {
      throw new PermanentError('LLM_REFUSED', 'refused');
    };
    const failed = await generatedCv();
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'LLM_REFUSED' } });

    const res = await me.agent.post(`/api/cvs/${failed.id}/retry`);
    expect(res.status).toBe(202);
    expect(res.body.cv).toMatchObject({
      status: 'generating',
      stage: 'queued',
      error: null,
      busy: true,
    });

    llm.overrides = {};
    await worker.drain();
    expect((await getCv(failed.id)).status).toBe('ready');
  });

  it('only retries failed CVs of the current user', async () => {
    const ready = await createCv(ctx.dataSource, me.userId);
    const notFailed = await me.agent.post(`/api/cvs/${ready.id}/retry`);
    expect(notFailed.status).toBe(409);
    expect(notFailed.body.error.code).toBe('INVALID_STATE');

    const other = await signedInUser(ctx.app);
    const foreign = await createCv(ctx.dataSource, other.user.id, {
      status: 'failed',
      content: null,
      review: null,
      errorCode: 'INTERNAL',
    });
    expect((await me.agent.post(`/api/cvs/${foreign.id}/retry`)).status).toBe(404);
    expect((await me.agent.post(`/api/cvs/${MISSING_ID}/retry`)).status).toBe(404);
    expect((await me.agent.post('/api/cvs/nope/retry')).status).toBe(400);
  });
});

describe('POST /api/cvs/:id/questions/:questionId/answer', () => {
  async function readyCvWithQuestion() {
    const cv = await generatedCv();
    const question = cv.questions.find((q) => q.section === 'experience' && q.itemId !== null);
    expect(question).toBeDefined();
    return { cv, question: question! };
  }

  function answer(cvId: string, questionId: string, text: string) {
    return me.agent.post(`/api/cvs/${cvId}/questions/${questionId}/answer`).send({ answer: text });
  }

  it('applies the answer to the targeted entry only and bumps the version once', async () => {
    const { cv, question } = await readyCvWithQuestion();
    const res = await answer(cv.id, question.id, 'I worked there from 2019 to 2023');
    expect(res.status).toBe(202);
    expect(res.body.cv.busy).toBe(true);
    expect(res.body.cv.questions.find((q: { id: string }) => q.id === question.id)).toMatchObject({
      status: 'applying',
      answer: 'I worked there from 2019 to 2023',
    });

    expect(await worker.drain()).toBe(1);
    const updated = await getCv(cv.id);
    expect(updated.version).toBe(cv.version + 1);
    expect(updated.busy).toBe(false);
    expect(updated.questions.find((q) => q.id === question.id)).toMatchObject({
      status: 'applied',
      error: null,
    });

    const before = cv.content!.experience.find((e) => e.id === question.itemId)!;
    const after = updated.content!.experience.find((e) => e.id === question.itemId)!;
    expect(after).toMatchObject({ id: before.id, startDate: '2019', endDate: '2023' });
    expect(after.bullets.map((b) => b.id)).toEqual(before.bullets.map((b) => b.id));
    // Nothing else changed, and the answer's years count as grounded.
    expect({ ...updated.content, experience: [] }).toEqual({ ...cv.content, experience: [] });
    expect(updated.review!.flags).toEqual([]);
  });

  it('rejects a second answer and manual edits while the CV is busy', async () => {
    const { cv, question } = await readyCvWithQuestion();
    const other = await createQuestion(ctx.dataSource, cv.id, {
      section: 'summary',
      itemId: null,
    });
    expect((await answer(cv.id, question.id, 'From 2019 to 2023')).status).toBe(202);

    const second = await answer(cv.id, other.id, 'Payments');
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CV_BUSY');

    const patch = await me.agent
      .patch(`/api/cvs/${cv.id}`)
      .send({ version: cv.version, title: 'x' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('CV_BUSY');
    // The rejected answer left the other question untouched.
    expect((await getCv(cv.id)).questions.find((q) => q.id === other.id)?.status).toBe('open');
  });

  it('answers 409 for a question that is not open/failed or a CV without content', async () => {
    const { cv, question } = await readyCvWithQuestion();
    await answer(cv.id, question.id, 'From 2019 to 2023');
    await worker.drain();
    const again = await answer(cv.id, question.id, 'Actually 2018');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');

    const generating = await createCv(ctx.dataSource, me.userId, {
      status: 'generating',
      stage: 'drafting',
      content: null,
      review: null,
    });
    const q = await createQuestion(ctx.dataSource, generating.id);
    const notReady = await answer(generating.id, q.id, 'Five');
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('CV_NOT_READY');
  });

  it('answers 409 when the entry the question is about was removed', async () => {
    const cv = await createCv(ctx.dataSource, me.userId);
    const q = await createQuestion(ctx.dataSource, cv.id, { itemId: 'removed-entry' });
    const res = await answer(cv.id, q.id, 'Five people');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('validates the answer and ownership', async () => {
    const cv = await createCv(ctx.dataSource, me.userId);
    const q = await createQuestion(ctx.dataSource, cv.id);
    expect((await answer(cv.id, q.id, '   ')).status).toBe(400);
    expect((await answer(cv.id, q.id, 'x'.repeat(2_001))).status).toBe(400);
    expect((await answer(cv.id, MISSING_ID, 'Five')).status).toBe(404);

    const other = await signedInUser(ctx.app);
    const res = await other.agent
      .post(`/api/cvs/${cv.id}/questions/${q.id}/answer`)
      .send({ answer: 'Five' });
    expect(res.status).toBe(404);
  });

  it('marks the question failed when applying fails, and lets the user answer again', async () => {
    const { cv, question } = await readyCvWithQuestion();
    llm.overrides.rewriteSection = () => {
      throw new PermanentError('LLM_REFUSED', 'refused');
    };
    await answer(cv.id, question.id, 'From 2019 to 2023');
    await worker.drain();
    const failed = await getCv(cv.id);
    expect(failed.version).toBe(cv.version);
    expect(failed.questions.find((q) => q.id === question.id)).toMatchObject({
      status: 'failed',
      error: 'LLM_REFUSED',
      errorMessage: 'The AI declined to process this source.',
    });

    llm.overrides = {};
    expect((await answer(cv.id, question.id, 'From 2019 to 2023')).status).toBe(202);
    await worker.drain();
    expect((await getCv(cv.id)).questions.find((q) => q.id === question.id)?.status).toBe(
      'applied',
    );
  });

  it('keeps what the user typed when an answer rewrites the same section', async () => {
    const cv = await generatedCv();
    const content = structuredClone(cv.content!);
    content.contact.email = 'jane.new@mail.com';
    const saved = await me.agent.patch(`/api/cvs/${cv.id}`).send({ version: cv.version, content });
    expect(saved.status).toBe(200);
    const question = await createQuestion(ctx.dataSource, cv.id, {
      section: 'contact',
      itemId: null,
      question: 'Which phone number should recruiters use?',
    });
    // A model that drops the email it did not find in the source.
    llm.overrides.rewriteSection = (input) => {
      if (input.section !== 'contact') throw new Error('unexpected section');
      return {
        section: 'contact',
        data: { ...input.current, email: '', phone: '+49 151 2345678' },
      };
    };

    expect((await answer(cv.id, question.id, 'Call me on +49 151 2345678')).status).toBe(202);
    await worker.drain();
    const updated = await getCv(cv.id);
    expect(updated.content!.contact).toMatchObject({
      email: 'jane.new@mail.com',
      phone: '+49 151 2345678',
    });
    expect(updated.review!.removed).toEqual([]);
  });

  it('turns a bare "yes" into a confirmed statement', async () => {
    const { cv, question } = await readyCvWithQuestion();
    await ctx.dataSource.query(`UPDATE cv_questions SET question = $1 WHERE id = $2`, [
      'Did you run the billing service on-call rotation for 2 years?',
      question.id,
    ]);
    llm.overrides.rewriteSection = (input) => {
      if (input.section !== 'experience') throw new Error('unexpected section');
      const [item] = input.current.items;
      return {
        section: 'experience',
        data: {
          items: [
            {
              ...item!,
              relevance: 80,
              bullets: [
                ...item!.bullets.map((text) => ({ text, evidence: [text] })),
                {
                  text: 'Ran the billing service on-call rotation for 2 years',
                  evidence: ['the billing service on-call rotation for 2 years'],
                },
              ],
            },
          ],
        },
      };
    };
    expect((await answer(cv.id, question.id, 'Yes')).status).toBe(202);
    await worker.drain();
    const updated = await getCv(cv.id);
    const entry = updated.content!.experience.find((e) => e.id === question.itemId)!;
    const added = entry.bullets.at(-1)!;
    expect(added.text).toBe('Ran the billing service on-call rotation for 2 years');
    expect(updated.review!.flags.filter((f) => f.itemId === added.id)).toEqual([]);
  });

  it('retries the rewrite when the CV changed underneath it', async () => {
    const { cv, question } = await readyCvWithQuestion();
    let calls = 0;
    const fake = new FakeLlmClient();
    llm.overrides.rewriteSection = async (input) => {
      calls++;
      if (calls === 1) {
        // A concurrent writer bumps the version between read and write.
        await ctx.dataSource.query(`UPDATE cvs SET version = version + 1 WHERE id = $1`, [cv.id]);
      }
      return fake.rewriteSection(input);
    };
    await answer(cv.id, question.id, 'From 2019 to 2023');
    await worker.drain();
    expect(calls).toBe(2);
    const updated = await getCv(cv.id);
    expect(updated.version).toBe(cv.version + 2);
    expect(updated.questions.find((q) => q.id === question.id)?.status).toBe('applied');
  });
});

describe('busy flag', () => {
  it('is reported in the list while a job is live', async () => {
    const cv = await createCv(ctx.dataSource, me.userId);
    await createJob(ctx.dataSource, cv.id, { status: 'queued' });
    const res = await me.agent.get('/api/cvs');
    expect(res.body.items[0]).toMatchObject({ id: cv.id, busy: true });
  });
});
