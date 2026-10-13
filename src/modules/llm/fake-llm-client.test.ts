import { describe, expect, it } from 'vitest';
import { sanitizeDraft } from '../generation/draft-sanitizer.js';
import { Corpus } from '../grounding/corpus.js';
import { verifyContent } from '../grounding/verifier.js';
import { TransientError } from '../jobs/job-errors.js';
import { FakeLlmClient } from './fake-llm-client.js';

const SOURCE = `Jane Doe
jane@example.com
github.com/janedoe
Backend engineer with eight years of experience building payment systems in Go.
Software Engineer at Acme Payments (2019 - Present)
- Built the billing service in Go and PostgreSQL
- Reduced p99 latency from 200ms to 120ms
TU Berlin, BSc Computer Science, 2012 - 2016
Skills: Go, PostgreSQL, Kafka`;

describe('FakeLlmClient', () => {
  it('drafts a plausible CV that only copies text from the source', async () => {
    const llm = new FakeLlmClient();
    const draft = await llm.draftCv({ sourceText: SOURCE, targetRole: 'Senior Backend Engineer' });
    expect(draft.contact).toMatchObject({ fullName: 'Jane Doe', email: 'jane@example.com' });
    expect(draft.experience).toHaveLength(1);
    expect(draft.experience[0]).toMatchObject({
      company: 'Acme Payments',
      title: 'Software Engineer',
      startDate: '2019',
      endDate: 'Present',
    });
    expect(draft.education[0]?.institution).toContain('TU Berlin');
    expect(draft.skills[0]?.items).toEqual(['Go', 'PostgreSQL', 'Kafka']);
    expect(draft.questions.length).toBeGreaterThan(0);

    // Grounded by construction: the verifier finds nothing to flag or remove.
    const sanitized = sanitizeDraft(draft);
    const { review } = verifyContent(
      sanitized.content,
      sanitized.claimedEvidence,
      new Corpus(SOURCE),
    );
    expect(review.flags).toEqual([]);
    expect(review.removed).toEqual([]);
  });

  it('does not take a date range for a phone number', async () => {
    const llm = new FakeLlmClient();
    const undated = await llm.draftCv({
      sourceText: `${SOURCE}\nDeveloper at Initech (2016 - 2019)`,
      targetRole: 'Backend Engineer',
    });
    expect(undated.contact.phone).toBe('');
    const withPhone = await llm.draftCv({
      sourceText: `${SOURCE}\nPhone: +49 151 2345 6789`,
      targetRole: 'Backend Engineer',
    });
    expect(withPhone.contact.phone).toBe('+49 151 2345 6789');
  });

  it('uses per-method overrides, including thrown errors', async () => {
    const llm = new FakeLlmClient({
      overrides: {
        draftCv: () => {
          throw new TransientError('overloaded');
        },
      },
    });
    await expect(llm.draftCv({ sourceText: SOURCE, targetRole: 'x' })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(llm.calls.draftCv).toBe(1);
  });

  it('honours the abort signal during its artificial delay', async () => {
    const llm = new FakeLlmClient({ delayMs: 10_000 });
    const controller = new AbortController();
    const reason = new Error('stop');
    const pending = llm.transcribePdf(Buffer.from('%PDF-'), { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
