import { describe, expect, it } from 'vitest';
import { sampleContent } from '../../../test/fixtures/cv-content.js';
import type { CvContent } from '../cvs/cv-content.schema.js';
import type { NewQuestion } from './draft-sanitizer.js';
import { withGapQuestions } from './gap-questions.js';

const EN_SOURCE = 'Jane Doe, backend engineer at Acme Payments since March 2021.';

function withGaps(patch: (content: CvContent) => void): CvContent {
  const content = sampleContent();
  patch(content);
  return content;
}

describe('withGapQuestions', () => {
  it('adds nothing when the CV has no structural gaps', () => {
    expect(withGapQuestions(sampleContent(), [], EN_SOURCE)).toEqual([]);
  });

  it('asks about every structural gap the model left out', () => {
    const content = withGaps((c) => {
      c.contact.email = '';
      c.experience[0]!.endDate = '';
      c.education = [];
      c.skills = [];
    });
    expect(withGapQuestions(content, [], EN_SOURCE)).toEqual([
      { section: 'contact', itemId: null, question: expect.stringContaining('email') },
      {
        section: 'experience',
        itemId: 'exp-1',
        question: expect.stringContaining('Acme Payments'),
      },
      { section: 'education', itemId: null, question: expect.any(String) },
      { section: 'skills', itemId: null, question: expect.any(String) },
    ]);
  });

  it('asks for responsibilities rather than dates when an entry has no bullets', () => {
    const content = withGaps((c) => {
      c.experience[0]!.bullets = [];
      c.experience[0]!.startDate = '';
    });
    const [question] = withGapQuestions(content, [], EN_SOURCE);
    expect(question?.question).toMatch(/responsibilities/);
  });

  it('asks for a phone or link only when the CV has an email but neither of them', () => {
    const content = withGaps((c) => {
      c.contact.phone = '';
      c.contact.links = [];
    });
    expect(withGapQuestions(content, [], EN_SOURCE)).toEqual([
      { section: 'contact', itemId: null, question: expect.stringContaining('phone') },
    ]);
  });

  it('keeps model questions first and skips gaps they already cover', () => {
    const model: NewQuestion[] = [
      { section: 'contact', itemId: null, question: 'Which email and phone should we show?' },
    ];
    const content = withGaps((c) => {
      c.contact.email = '';
      c.skills = [];
    });
    expect(withGapQuestions(content, model, EN_SOURCE)).toEqual([
      model[0],
      { section: 'skills', itemId: null, question: expect.any(String) },
    ]);
  });

  it('writes the questions in Russian for a Cyrillic source', () => {
    const content = withGaps((c) => {
      c.skills = [];
    });
    const [question] = withGapQuestions(content, [], 'Ольга Смирнова, Python-разработчик в Москве');
    expect(question?.question).toMatch(/навыки/);
  });

  it('never exceeds the question limit', () => {
    const model = Array.from({ length: 8 }, (_, i) => ({
      section: 'summary' as const,
      itemId: null,
      question: `Question ${i}?`,
    }));
    const content = withGaps((c) => {
      c.skills = [];
    });
    expect(withGapQuestions(content, model, EN_SOURCE)).toEqual(model);
  });
});
