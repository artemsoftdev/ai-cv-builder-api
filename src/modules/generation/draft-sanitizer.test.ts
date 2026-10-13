import { describe, expect, it } from 'vitest';
import { CV_CONTENT_LIMITS as L } from '../cvs/cv-content.schema.js';
import { sanitizeDraft } from './draft-sanitizer.js';
import type { DraftCv, DraftExperience } from './llm-output.schemas.js';

const BELL = String.fromCharCode(0x07);
const RLO = String.fromCharCode(0x202e);
const EMOJI = String.fromCodePoint(0x1f600); // a surrogate pair

function experience(overrides: Partial<DraftExperience> = {}): DraftExperience {
  return {
    company: 'Acme',
    title: 'Engineer',
    location: '',
    startDate: '2019',
    endDate: 'Present',
    relevance: 50,
    bullets: [{ text: 'Built the billing service', evidence: ['Built the billing service'] }],
    ...overrides,
  };
}

function draft(overrides: Partial<DraftCv> = {}): DraftCv {
  return {
    contact: {
      fullName: 'Jane Doe',
      headline: 'Backend Engineer',
      email: 'jane@example.com',
      phone: '',
      location: '',
      links: [],
    },
    summary: { text: 'Backend engineer.', evidence: ['Backend engineer'] },
    experience: [experience()],
    education: [],
    skills: [],
    questions: [],
    ...overrides,
  };
}

let counter = 0;
const sequentialIds = () => `id-${++counter}`;

describe('sanitizeDraft', () => {
  it('assigns unique ids and records the claimed evidence per bullet and summary', () => {
    const { content, claimedEvidence } = sanitizeDraft(
      draft({
        experience: [
          experience({
            bullets: [
              { text: 'A', evidence: ['a', 'a', '  ', 'b', 'c', 'd'] },
              { text: 'B', evidence: [] },
            ],
          }),
        ],
      }),
    );
    const ids = [content.experience[0]!.id, ...content.experience[0]!.bullets.map((b) => b.id)];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const [a, b] = content.experience[0]!.bullets;
    expect(claimedEvidence[a!.id]).toEqual(['a', 'b', 'c']); // deduped, max 3
    expect(claimedEvidence[b!.id]).toEqual([]);
    expect(claimedEvidence.summary).toEqual(['Backend engineer']);
  });

  it('strips control and bidi characters and clamps lengths to the contract limits', () => {
    const { content } = sanitizeDraft(
      draft({
        contact: { ...draft().contact, fullName: `Ja${BELL}ne ${RLO}Doe` },
        summary: { text: 'x'.repeat(L.summary + 100), evidence: [] },
        experience: [
          experience({
            company: 'A'.repeat(L.text - 1) + EMOJI,
            bullets: Array.from({ length: 20 }, (_, i) => ({
              text: `${i} ${'word '.repeat(100)}`,
              evidence: [],
            })),
          }),
        ],
      }),
    );
    expect(content.contact.fullName).toBe('Jane Doe');
    expect(content.summary).toHaveLength(L.summary);
    const item = content.experience[0]!;
    // Cut before the emoji rather than through it.
    expect(item.company).toBe('A'.repeat(L.text - 1));
    expect(item.bullets).toHaveLength(L.bulletsPerItem);
    for (const bullet of item.bullets) expect(bullet.text.length).toBeLessThanOrEqual(L.bullet);
  });

  it('drops empty entries, duplicate bullets and unsafe links', () => {
    const { content } = sanitizeDraft(
      draft({
        contact: {
          ...draft().contact,
          links: [
            { label: 'GitHub', url: 'https://github.com/jane' },
            { label: 'Evil', url: 'javascript:alert(1)' },
            { label: '', url: 'github.com/jane2' },
            { label: 'Dup', url: 'https://github.com/jane' },
          ],
        },
        experience: [
          experience({ company: ' ', title: '', bullets: [] }),
          experience({
            bullets: [
              { text: 'Same', evidence: [] },
              { text: ' Same ', evidence: [] },
              { text: '', evidence: [] },
            ],
          }),
        ],
        education: [
          {
            institution: '',
            degree: '',
            location: 'Berlin',
            startDate: '',
            endDate: '',
            details: '',
          },
        ],
        skills: [
          { name: '', items: ['Go', 'go', ' ', 'Rust'] },
          { name: 'Other', items: ['Rust'] },
        ],
      }),
    );
    expect(content.contact.links.map((l) => [l.label, l.url])).toEqual([
      ['GitHub', 'https://github.com/jane'],
      ['github.com/jane2', 'github.com/jane2'],
    ]);
    expect(content.experience).toHaveLength(1);
    expect(content.experience[0]!.bullets.map((b) => b.text)).toEqual(['Same']);
    expect(content.education).toEqual([]);
    expect(content.skills.map((g) => [g.name, g.items])).toEqual([['Skills', ['Go', 'Rust']]]);
  });

  it('orders experience by relevance (stable for ties) and caps the count', () => {
    const { content } = sanitizeDraft(
      draft({
        experience: [
          experience({ company: 'Low', relevance: 10 }),
          experience({ company: 'TieA', relevance: 70 }),
          experience({ company: 'High', relevance: 95 }),
          experience({ company: 'TieB', relevance: 70 }),
          experience({ company: 'Weird', relevance: Number.NaN }),
          experience({ company: 'Over', relevance: 250 }),
        ],
      }),
    );
    expect(content.experience.map((e) => e.company)).toEqual([
      'Over',
      'High',
      'TieA',
      'TieB',
      'Low',
      'Weird',
    ]);

    const many = sanitizeDraft(
      draft({ experience: Array.from({ length: 40 }, () => experience()) }),
    );
    expect(many.content.experience).toHaveLength(L.experienceItems);
  });

  it('maps question item indexes to ids after sorting and drops invalid questions', () => {
    const { content, questions } = sanitizeDraft(
      draft({
        experience: [
          experience({ company: 'First', relevance: 10 }),
          experience({ company: 'Second', relevance: 90 }),
        ],
        questions: [
          { section: 'experience', itemIndex: 0, question: 'When did you join First?' },
          { section: 'Experience ', itemIndex: null, question: 'Any other jobs?' },
          { section: 'experience', itemIndex: 7, question: 'About a missing entry?' },
          { section: 'hobbies', itemIndex: null, question: 'Unknown section?' },
          { section: 'summary', itemIndex: 3, question: 'What is your focus?' },
          { section: 'summary', itemIndex: null, question: '  ' },
          { section: 'summary', itemIndex: null, question: 'What is your focus?' },
        ],
      }),
    );
    const first = content.experience.find((e) => e.company === 'First')!;
    expect(questions).toEqual([
      { section: 'experience', itemId: first.id, question: 'When did you join First?' },
      { section: 'experience', itemId: null, question: 'Any other jobs?' },
      { section: 'summary', itemId: null, question: 'What is your focus?' },
    ]);
  });

  it('keeps at most 8 questions', () => {
    const { questions } = sanitizeDraft(
      draft({
        questions: Array.from({ length: 12 }, (_, i) => ({
          section: 'summary',
          itemIndex: null,
          question: `Question ${i}?`,
        })),
      }),
    );
    expect(questions).toHaveLength(8);
  });

  it('uses the id factory it is given', () => {
    counter = 0;
    const { content } = sanitizeDraft(draft(), sequentialIds);
    expect(content.experience[0]!.id).toBe('id-1');
    expect(content.experience[0]!.bullets[0]!.id).toBe('id-2');
  });
});
