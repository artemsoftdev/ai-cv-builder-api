import { describe, expect, it } from 'vitest';
import { sampleContent, sampleReview } from '../../../test/fixtures/cv-content.js';
import { planCvPatch, type CvEditableState } from './cv-patch.js';

function current(): CvEditableState {
  return { title: 'My CV', content: sampleContent(), review: sampleReview() };
}

describe('planCvPatch', () => {
  it('returns null for a no-op (same title, deep-equal content, nothing dismissed)', () => {
    // Re-ordered keys, as content coming back from a jsonb column would be.
    const { contact, summary, experience, education, skills } = sampleContent();
    const reordered = { skills, education, experience, summary, contact };
    expect(planCvPatch(current(), { title: 'My CV', content: reordered })).toBeNull();
    expect(planCvPatch(current(), {})).toBeNull();
  });

  it('changes only the title', () => {
    expect(planCvPatch(current(), { title: 'Backend CV' })).toEqual({ title: 'Backend CV' });
  });

  it('changes content and prunes flags of edited items', () => {
    const content = sampleContent();
    content.summary = 'Rewritten by hand.';
    const changes = planCvPatch(current(), { content });
    expect(changes?.content).toEqual(content);
    expect(changes?.review?.flags.map((flag) => flag.id)).toEqual(['flag-bullet', 'flag-exp']);
    // The rest of the review is preserved.
    expect(changes?.review?.removed).toEqual(sampleReview().removed);
    expect(changes?.review?.evidence).toEqual(sampleReview().evidence);
  });

  it('drops evidence of rewritten text so it is not shown as found in the source', () => {
    const content = sampleContent();
    content.experience[0]!.bullets[0]!.text = 'Cut infra costs by 40%';
    const changes = planCvPatch(current(), { content });
    expect(changes?.review?.evidence).toEqual({});

    const removed = sampleContent();
    removed.experience[0]!.bullets.shift();
    expect(planCvPatch(current(), { content: removed })?.review?.evidence).toEqual({});
  });

  it('dismisses flags without touching content', () => {
    const changes = planCvPatch(current(), { dismissFlagIds: ['flag-summary'] });
    expect(changes).toEqual({
      review: { ...sampleReview(), flags: sampleReview().flags.slice(0, 2) },
    });
  });

  it('ignores dismissal of unknown flag ids', () => {
    expect(planCvPatch(current(), { dismissFlagIds: ['nope'] })).toBeNull();
  });

  it('works for a CV without a review', () => {
    const state = { ...current(), review: null };
    const content = sampleContent();
    content.skills[0]!.items.push('SQL');
    expect(planCvPatch(state, { content })).toEqual({ content });
  });
});
