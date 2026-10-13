import { describe, expect, it } from 'vitest';
import type { CvDto } from '../../src/modules/cvs/cv.types.js';
import type { DraftCv } from '../../src/modules/generation/llm-output.schemas.js';
import { REASONS } from '../../src/modules/grounding/verifier.js';
import { browser, DEFAULT_PASSWORD, signedInUser } from '../helpers/app.js';
import { gate, getCv, isSettled, pollCv, useE2eStack } from '../helpers/e2e.js';
import { inspectPdf } from '../helpers/pdf-inspect.js';

const stack = useE2eStack();

const SOURCE = `Jane Doe
jane@example.com | +49 30 1234567 | github.com/janedoe
Berlin, Germany
Backend engineer with eight years of experience building payment systems in Go.

Software Engineer at Acme Payments (2019 - Present)
- Built the billing service in Go and PostgreSQL
- Reduced p99 latency from 200ms to 120ms

Junior Developer at Globex (2015 - 2019)
- Maintained the internal reporting tool in PHP

TU Berlin, BSc Computer Science (2011 - 2015)
Skills: Go, PostgreSQL, PHP, Docker`;

/** What Claude might return: mostly faithful, one invented metric and one invented skill. */
const DRAFT: DraftCv = {
  contact: {
    fullName: 'Jane Doe',
    headline: 'Software Engineer',
    email: 'jane@example.com',
    phone: '+49 30 1234567',
    location: 'Berlin, Germany',
    links: [{ label: 'GitHub', url: 'github.com/janedoe' }],
  },
  summary: {
    text: 'Backend engineer with 8 years of experience building payment systems in Go.',
    evidence: ['eight years of experience building payment systems'],
  },
  experience: [
    {
      company: 'Globex',
      title: 'Junior Developer',
      location: '',
      startDate: '2015',
      endDate: '2019',
      relevance: 35,
      bullets: [
        {
          text: 'Maintained the internal reporting tool in PHP',
          evidence: ['Maintained the internal reporting tool'],
        },
      ],
    },
    {
      company: 'Acme Payments',
      title: 'Software Engineer',
      location: '',
      startDate: '2019',
      endDate: 'Present',
      relevance: 90,
      bullets: [
        {
          text: 'Built the billing service in Go and PostgreSQL',
          evidence: ['Built the billing service in Go'],
        },
        {
          text: 'Cut p99 latency by 40% (200ms to 120ms)',
          evidence: ['Reduced p99 latency from 200ms to 120ms'],
        },
      ],
    },
  ],
  education: [
    {
      institution: 'TU Berlin',
      degree: 'BSc Computer Science',
      location: '',
      startDate: '2011',
      endDate: '2015',
      details: '',
    },
  ],
  skills: [
    { name: 'Languages', items: ['Go', 'PHP'] },
    { name: 'Tools', items: ['PostgreSQL', 'Docker', 'Kubernetes'] },
  ],
  questions: [
    {
      section: 'experience',
      itemIndex: 1,
      question: 'How large was the team you worked in at Acme Payments, and what was your role?',
    },
    { section: 'summary', itemIndex: null, question: 'Which backend role are you aiming for?' },
  ],
};

const flagsOf = (cv: CvDto, itemId: string) =>
  cv.review!.flags.filter((flag) => flag.itemId === itemId).map((flag) => flag.reason);

describe('a CV from pasted text to PDF and back from another device', () => {
  it('generates, verifies, edits, answers, exports and deletes', async () => {
    const { agent, user } = await signedInUser(stack.app, 'jane@example.com');
    stack.llm.overrides.draftCv = () => DRAFT;

    // Create: the request returns at once, the worker does the slow part.
    const created = await agent
      .post('/api/cvs')
      .field('targetRole', 'Senior Backend Engineer')
      .field('text', SOURCE);
    expect(created.status).toBe(202);
    expect(created.body.cv).toMatchObject({
      targetRole: 'Senior Backend Engineer',
      sourceType: 'text',
    });
    const id = (created.body as { cv: CvDto }).cv.id;

    const { cv: ready } = await pollCv(agent, id, isSettled);
    expect(ready).toMatchObject({ status: 'ready', stage: 'done', error: null, version: 2 });
    const content = ready.content!;
    expect(content.contact).toMatchObject({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+49 30 1234567',
      location: 'Berlin, Germany',
      links: [expect.objectContaining({ url: 'github.com/janedoe' })],
    });
    expect(content.summary).toContain('8 years');
    // Most relevant experience first, whatever order the model used.
    expect(content.experience.map((e) => e.company)).toEqual(['Acme Payments', 'Globex']);
    expect(content.education).toEqual([expect.objectContaining({ institution: 'TU Berlin' })]);
    expect(content.skills.flatMap((g) => g.items)).toEqual(['Go', 'PHP', 'PostgreSQL', 'Docker']);

    // The invented metric is flagged, the invented skill removed, the rest verified.
    const acme = content.experience[0]!;
    const [built, latency] = acme.bullets;
    expect(flagsOf(ready, latency!.id)).toEqual([REASONS.number('40')]);
    expect(ready.review!.flags).toHaveLength(1);
    expect(ready.review!.removed).toEqual([
      { field: 'skills', value: 'Kubernetes', reason: REASONS.skill },
    ]);
    expect(ready.review!.evidence[built!.id]).toEqual(['Built the billing service in Go']);
    const [experienceQuestion, summaryQuestion] = ready.questions;
    expect(experienceQuestion).toMatchObject({ section: 'experience', itemId: acme.id });
    expect(summaryQuestion).toMatchObject({ section: 'summary', itemId: null, status: 'open' });

    // Edit by hand: the flag on the rewritten bullet goes away, the version moves on.
    const edited = structuredClone(content);
    edited.experience[0]!.bullets[1]!.text = 'Cut p99 latency from 200ms to 120ms';
    const patched = await agent
      .patch(`/api/cvs/${id}`)
      .send({ version: ready.version, title: 'Backend CV', content: edited });
    expect(patched.status).toBe(200);
    expect(patched.body.cv).toMatchObject({ title: 'Backend CV', version: ready.version + 1 });
    expect(patched.body.cv.review.flags).toEqual([]);

    // A save from a stale tab is refused, not merged blindly.
    const stale = await agent
      .patch(`/api/cvs/${id}`)
      .send({ version: ready.version, title: 'Old' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toEqual({
      code: 'VERSION_CONFLICT',
      message: expect.any(String),
      details: { currentVersion: ready.version + 1 },
    });

    // Answer a question: the CV is busy and read-only until the rewrite lands.
    const rewrite = gate();
    stack.llm.overrides.rewriteSection = async (input) => {
      if (input.section !== 'experience') throw new Error('unexpected section');
      await rewrite.opened;
      const [entry] = input.current.items;
      return {
        section: 'experience',
        data: {
          items: [
            {
              ...entry!,
              relevance: 90,
              bullets: [
                ...entry!.bullets.map((text) => ({ text, evidence: [text] })),
                {
                  text: 'Led the on-call rotation in a team of 6 engineers',
                  evidence: ['led the on-call rotation'],
                },
              ],
            },
          ],
        },
      };
    };
    const answered = await agent
      .post(`/api/cvs/${id}/questions/${experienceQuestion!.id}/answer`)
      .send({ answer: 'A team of 6 engineers; I led the on-call rotation.' });
    expect(answered.status).toBe(202);
    expect(answered.body.cv.busy).toBe(true);
    const busy = await pollCv(agent, id, (cv) =>
      cv.questions.some((q) => q.id === experienceQuestion!.id && q.status === 'applying'),
    );
    const blocked = await agent
      .patch(`/api/cvs/${id}`)
      .send({ version: busy.cv.version, title: 'During rewrite' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CV_BUSY');
    const secondAnswer = await agent
      .post(`/api/cvs/${id}/questions/${summaryQuestion!.id}/answer`)
      .send({ answer: 'Payments platforms' });
    expect(secondAnswer.status).toBe(409);
    expect(secondAnswer.body.error.code).toBe('CV_BUSY');

    rewrite.open();
    const { cv: afterAnswer } = await pollCv(agent, id, (cv) => !cv.busy);
    expect(afterAnswer.version).toBe(ready.version + 2);
    expect(afterAnswer.questions.find((q) => q.id === experienceQuestion!.id)).toMatchObject({
      status: 'applied',
      error: null,
    });
    const rewritten = afterAnswer.content!.experience[0]!;
    expect(rewritten.id).toBe(acme.id);
    expect(rewritten.bullets.map((b) => b.text)).toEqual([
      'Built the billing service in Go and PostgreSQL',
      'Cut p99 latency from 200ms to 120ms',
      'Led the on-call rotation in a team of 6 engineers',
    ]);
    expect(rewritten.bullets.slice(0, 2).map((b) => b.id)).toEqual(acme.bullets.map((b) => b.id));
    // Only the targeted entry changed; the user's edit is grounded, so nothing is flagged.
    expect({ ...afterAnswer.content, experience: [] }).toEqual({ ...edited, experience: [] });
    expect(afterAnswer.content!.experience[1]).toEqual(edited.experience[1]);
    expect(afterAnswer.review!.flags).toEqual([]);

    const dismissed = await agent.post(`/api/cvs/${id}/questions/${summaryQuestion!.id}/dismiss`);
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.cv.questions[1].status).toBe('dismissed');

    // Export: real, selectable text in an A4 PDF, including the edits.
    const pdf = await agent
      .get(`/api/cvs/${id}/pdf`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-disposition']).toContain('filename="Jane Doe - Backend CV.pdf"');
    const document = await inspectPdf(pdf.body as Buffer);
    expect(document.pageSizes[0]).toEqual({
      width: expect.closeTo(595.28, 1),
      height: expect.closeTo(841.89, 1),
    });
    expect(document.text).toContain('Jane Doe');
    expect(document.text).toContain('Cut p99 latency from 200ms to 120ms');
    expect(document.text).toContain('Led the on-call rotation in a team of 6 engineers');
    expect(document.text).not.toContain('Kubernetes');

    // Another device: log in and find the same CV.
    const laptop = browser(stack.app);
    expect(
      (await laptop.post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD }))
        .status,
    ).toBe(200);
    const list = await laptop.get('/api/cvs');
    expect(list.body.items).toEqual([
      expect.objectContaining({ id, title: 'Backend CV', busy: false, openQuestions: 0 }),
    ]);
    expect(await getCv(laptop, id)).toEqual(await getCv(agent, id));

    expect((await laptop.delete(`/api/cvs/${id}`)).status).toBe(204);
    expect((await agent.get(`/api/cvs/${id}`)).status).toBe(404);
    expect((await agent.get('/api/cvs')).body.items).toEqual([]);
  });
});
