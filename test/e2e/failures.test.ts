import { describe, expect, it } from 'vitest';
import { PermanentError, TransientError } from '../../src/modules/jobs/job-errors.js';
import { FakeLlmClient } from '../../src/modules/llm/fake-llm-client.js';
import { signedInUser, type Browser } from '../helpers/app.js';
import { isSettled, pollCv, useE2eStack } from '../helpers/e2e.js';

const stack = useE2eStack();

const SOURCE = `Jane Doe
jane@example.com
Backend engineer with eight years of experience building payment systems in Go.
Software Engineer at Acme Payments (2019 - Present)
- Built the billing service in Go and PostgreSQL
Skills: Go, PostgreSQL`;

async function create(agent: Browser): Promise<string> {
  const res = await agent
    .post('/api/cvs')
    .field('targetRole', 'Backend Engineer')
    .field('text', SOURCE);
  expect(res.status).toBe(202);
  return res.body.cv.id as string;
}

describe('when Claude fails', () => {
  it('fails the CV on a permanent error, and a retry generates it', async () => {
    const { agent } = await signedInUser(stack.app);
    stack.llm.overrides.draftCv = () => {
      throw new PermanentError('LLM_REFUSED', 'refusal (category: cyber)');
    };
    const id = await create(agent);

    const { cv: failed } = await pollCv(agent, id, isSettled);
    expect(failed).toMatchObject({
      status: 'failed',
      content: null,
      busy: false,
      error: { code: 'LLM_REFUSED', message: 'The AI declined to process this source.' },
    });
    expect(JSON.stringify(failed)).not.toContain('cyber');

    stack.llm.overrides = {};
    const retried = await agent.post(`/api/cvs/${id}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.body.cv).toMatchObject({ status: 'generating', stage: 'queued', error: null });
    const { cv } = await pollCv(agent, id, isSettled);
    expect(cv.status).toBe('ready');
  });

  it.each([
    ['an overloaded API', new TransientError('Anthropic overloaded')],
    ['invalid output', new TransientError('not valid JSON', 'LLM_INVALID_OUTPUT')],
  ])('retries %s on its own', async (_name, error) => {
    const { agent } = await signedInUser(stack.app);
    let calls = 0;
    stack.llm.overrides.draftCv = (input) => {
      calls++;
      if (calls === 1) throw error;
      return new FakeLlmClient().draftCv(input);
    };
    const id = await create(agent);
    const { cv } = await pollCv(agent, id, isSettled);
    expect(cv.status).toBe('ready');
    expect(calls).toBe(2);
  });

  it('marks a failed answer with a reason and lets the user answer again', async () => {
    const { agent } = await signedInUser(stack.app);
    const id = await create(agent);
    const { cv } = await pollCv(agent, id, isSettled);
    const question = cv.questions.find((q) => q.section === 'experience')!;
    stack.llm.overrides.rewriteSection = () => {
      throw new PermanentError('LLM_NOT_CONFIGURED', 'missing key');
    };

    const answer = () =>
      agent
        .post(`/api/cvs/${id}/questions/${question.id}/answer`)
        .send({ answer: 'I worked there from 2019 to 2023' });
    expect((await answer()).status).toBe(202);
    const { cv: afterFailure } = await pollCv(agent, id, (c) => !c.busy);
    expect(afterFailure.questions.find((q) => q.id === question.id)).toMatchObject({
      status: 'failed',
      error: 'LLM_NOT_CONFIGURED',
      errorMessage: 'AI generation is not configured on the server.',
    });
    expect(afterFailure.version).toBe(cv.version);

    stack.llm.overrides = {};
    expect((await answer()).status).toBe(202);
    const { cv: applied } = await pollCv(agent, id, (c) => !c.busy);
    expect(applied.questions.find((q) => q.id === question.id)).toMatchObject({
      status: 'applied',
      error: null,
      errorMessage: null,
    });
  });
});
