import { describe, expect, it } from 'vitest';
import { sampleContent, sampleReview } from '../../../test/fixtures/cv-content.js';
import {
  confirmedFacts,
  editedValues,
  MAX_USER_FACTS,
  mergeUserFacts,
  targetTexts,
} from './user-facts.js';

describe('editedValues', () => {
  it('returns new and changed values only', () => {
    const before = sampleContent();
    const after = sampleContent();
    after.contact.email = 'jane.new@mail.com';
    after.experience[0]!.bullets[1]!.text = 'Cut p99 latency by 45%.';
    after.experience[0]!.bullets.push({ id: 'b-new', text: 'Ran the on-call rotation.' });
    after.education[0]!.details = 'Thesis on consensus';
    after.skills[0]!.items.push('Docker', 'go');
    expect(editedValues(before, after)).toEqual([
      'jane.new@mail.com',
      'Cut p99 latency by 45%.',
      'Ran the on-call rotation.',
      'Thesis on consensus',
      'Docker',
    ]);
    expect(editedValues(before, sampleContent())).toEqual([]);
  });

  it('ignores cleared fields', () => {
    const after = sampleContent();
    after.contact.phone = '';
    expect(editedValues(sampleContent(), after)).toEqual([]);
  });
});

describe('targetTexts', () => {
  it('gives the text a flag is about', () => {
    const content = sampleContent();
    expect(targetTexts(content, 'summary')).toEqual([content.summary]);
    expect(targetTexts(content, 'headline')).toEqual(['Senior Backend Engineer']);
    expect(targetTexts(content, 'b-2')).toEqual(['Cut p99 latency by 40%.']);
    expect(targetTexts(content, 'exp-1')).toEqual([
      'Acme Payments',
      'Backend Engineer',
      'Berlin',
      'Mar 2021',
      'Present',
    ]);
    expect(targetTexts(content, 'missing')).toEqual([]);
  });
});

describe('confirmedFacts', () => {
  it('combines edited values and the targets of dismissed flags', () => {
    const content = sampleContent();
    content.contact.location = 'Potsdam';
    const facts = confirmedFacts(
      { title: 'CV', content: sampleContent(), review: sampleReview() },
      { content, dismissFlagIds: ['flag-bullet', 'unknown'] },
    );
    expect(facts).toEqual(['Potsdam', 'Cut p99 latency by 40%.']);
  });

  it('is empty for a CV without content', () => {
    expect(confirmedFacts({ title: 'CV', content: null, review: null }, {})).toEqual([]);
  });
});

describe('mergeUserFacts', () => {
  it('keeps each fact once, newest last, within the limits', () => {
    expect(mergeUserFacts(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    const many = Array.from({ length: MAX_USER_FACTS + 5 }, (_, i) => `fact ${i}`);
    const merged = mergeUserFacts([], many);
    expect(merged).toHaveLength(MAX_USER_FACTS);
    expect(merged.at(-1)).toBe(`fact ${MAX_USER_FACTS + 4}`);
    expect(mergeUserFacts(['x'.repeat(39_999)], ['newer fact'])).toEqual(['newer fact']);
  });
});
