import { describe, expect, it } from 'vitest';
import type { CvContent } from '../cvs/cv-content.schema.js';
import { Corpus } from '../grounding/corpus.js';
import { REASONS } from '../grounding/verifier.js';
import { PermanentError } from '../jobs/job-errors.js';
import { applySectionRewrite, sectionSnapshot } from './section-rewrite.js';

const SOURCE = `Jane Doe, jane@example.com, github.com/janedoe
Software Engineer at Acme Payments
- Built the billing service in Go
- Maintained the payment gateway
TU Berlin, BSc Computer Science
Skills: Go, PostgreSQL`;

function content(): CvContent {
  return {
    contact: {
      fullName: 'Jane Doe',
      headline: 'Software Engineer',
      email: 'jane@example.com',
      phone: '',
      location: '',
      links: [{ id: 'link-1', label: 'GitHub', url: 'github.com/janedoe' }],
    },
    summary: 'Software engineer.',
    experience: [
      {
        id: 'exp-1',
        company: 'Acme Payments',
        title: 'Software Engineer',
        location: '',
        startDate: '',
        endDate: '',
        bullets: [
          { id: 'b-1', text: 'Built the billing service in Go' },
          { id: 'b-2', text: 'Maintained the payment gateway' },
        ],
      },
    ],
    education: [
      {
        id: 'edu-1',
        institution: 'TU Berlin',
        degree: 'BSc Computer Science',
        location: '',
        startDate: '',
        endDate: '',
        details: '',
      },
    ],
    skills: [{ id: 'skills-1', name: 'Languages', items: ['Go'] }],
  };
}

let n = 0;
const ids = () => `new-${++n}`;

describe('sectionSnapshot', () => {
  it('shows the model the targeted entry without ids', () => {
    expect(sectionSnapshot(content(), { section: 'experience', itemId: 'exp-1' })).toEqual({
      section: 'experience',
      current: {
        items: [
          {
            company: 'Acme Payments',
            title: 'Software Engineer',
            location: '',
            startDate: '',
            endDate: '',
            bullets: ['Built the billing service in Go', 'Maintained the payment gateway'],
          },
        ],
      },
    });
    expect(sectionSnapshot(content(), { section: 'education', itemId: null })).toEqual({
      section: 'education',
      current: { items: [] },
    });
  });

  it('fails permanently when the entry no longer exists', () => {
    expect(() => sectionSnapshot(content(), { section: 'experience', itemId: 'gone' })).toThrow(
      PermanentError,
    );
  });
});

describe('applySectionRewrite', () => {
  const answer = 'I worked there from 2019 to 2021 and led a team of 4 engineers';
  const corpus = new Corpus(SOURCE, [answer]);

  it('updates only the target entry, keeping its id and the ids of unchanged bullets', () => {
    const before = content();
    const result = applySectionRewrite(
      before,
      { section: 'experience', itemId: 'exp-1' },
      {
        section: 'experience',
        data: {
          items: [
            {
              company: 'Acme Payments',
              title: 'Software Engineer',
              location: '',
              startDate: '2019',
              endDate: '2021',
              relevance: 80,
              bullets: [
                { text: 'Built the billing service in Go', evidence: ['billing service in Go'] },
                { text: 'Led a team of 4 engineers', evidence: ['led a team of 4 engineers'] },
                { text: 'Cut costs by 30%', evidence: ['Maintained the payment gateway'] },
              ],
            },
          ],
        },
      },
      corpus,
      ids,
    );
    const item = result.content.experience[0]!;
    expect(item.id).toBe('exp-1');
    expect(item.startDate).toBe('2019');
    expect(item.bullets[0]!.id).toBe('b-1');
    expect(item.bullets[1]!.id).toMatch(/^new-/);
    // Everything else is untouched.
    expect(result.content.education).toEqual(before.education);
    expect(result.content.summary).toBe(before.summary);
    // The new part is verified against source + answers.
    // The quote for "Cut costs by 30%" exists but says nothing about it.
    expect(result.review.flags.map((f) => [f.itemId, f.reason])).toEqual([
      [item.bullets[2]!.id, REASONS.noEvidence],
      [item.bullets[2]!.id, REASONS.number('30')],
    ]);
    expect(result.review.evidence[item.bullets[1]!.id]).toEqual(['led a team of 4 engineers']);
    expect([...result.scope.targetIds]).toEqual(
      expect.arrayContaining(['exp-1', 'b-1', 'b-2', item.bullets[1]!.id]),
    );
  });

  it('appends new entries when the question was about missing ones', () => {
    const result = applySectionRewrite(
      content(),
      { section: 'experience', itemId: null },
      {
        section: 'experience',
        data: {
          items: [
            {
              company: 'Globex',
              title: 'Intern',
              location: '',
              startDate: '',
              endDate: '',
              relevance: 10,
              bullets: [],
            },
            // The existing entry repeated by the model is not added twice.
            {
              company: 'acme payments',
              title: 'Software Engineer',
              location: '',
              startDate: '',
              endDate: '',
              relevance: 90,
              bullets: [],
            },
          ],
        },
      },
      new Corpus(SOURCE, ['I was an intern at Globex']),
      ids,
    );
    expect(result.content.experience.map((e) => e.company)).toEqual(['Acme Payments', 'Globex']);
    expect(result.review.flags).toEqual([]);
  });

  it('re-verifies contact data, keeping link ids and removing unsupported values', () => {
    const result = applySectionRewrite(
      content(),
      { section: 'contact', itemId: null },
      {
        section: 'contact',
        data: {
          fullName: 'Jane Doe',
          email: 'jane@example.com',
          phone: '+1 555 123 4567',
          location: '',
          links: [{ label: 'GitHub', url: 'github.com/janedoe' }],
        },
      },
      corpus,
      ids,
    );
    expect(result.content.contact.links).toEqual([
      { id: 'link-1', label: 'GitHub', url: 'github.com/janedoe' },
    ]);
    expect(result.content.contact.phone).toBe('');
    expect(result.content.contact.headline).toBe('Software Engineer');
    expect(result.review.removed).toEqual([
      { field: 'contact.phone', value: '+1 555 123 4567', reason: REASONS.phone },
    ]);
    expect(result.scope.removedFields).toEqual(['contact']);
  });

  it('keeps skill group ids by name and removes skills the corpus does not mention', () => {
    const result = applySectionRewrite(
      content(),
      { section: 'skills', itemId: null },
      {
        section: 'skills',
        data: {
          groups: [
            { name: 'languages', items: ['Go', 'Rust'] },
            { name: 'Databases', items: ['PostgreSQL'] },
          ],
        },
      },
      corpus,
      ids,
    );
    expect(result.content.skills.map((g) => [g.id, g.items])).toEqual([
      ['skills-1', ['Go']],
      [expect.stringMatching(/^new-/), ['PostgreSQL']],
    ]);
    expect(result.review.removed.map((r) => r.value)).toEqual(['Rust']);
  });

  it('does not let an empty summary from the model erase the existing one', () => {
    const result = applySectionRewrite(
      content(),
      { section: 'summary', itemId: null },
      { section: 'summary', data: { headline: '', summary: { text: '', evidence: [] } } },
      corpus,
      ids,
    );
    expect(result.content.summary).toBe('Software engineer.');
    expect(result.content.contact.headline).toBe('Software Engineer');
  });

  it('rejects a rewrite for another section', () => {
    expect(() =>
      applySectionRewrite(
        content(),
        { section: 'summary', itemId: null },
        { section: 'skills', data: { groups: [] } },
        corpus,
      ),
    ).toThrow(PermanentError);
  });
});
