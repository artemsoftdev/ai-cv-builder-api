import { describe, expect, it } from 'vitest';
import { sampleContent, sampleReview } from '../../../test/fixtures/cv-content.js';
import { pruneReviewFlags } from './review-flags.js';

const flagIds = (flags: { id: string }[]) => flags.map((flag) => flag.id);

describe('pruneReviewFlags', () => {
  const { flags } = sampleReview(); // flag-bullet -> b-2, flag-exp -> exp-1, flag-summary

  it('keeps every flag when nothing changed', () => {
    const content = sampleContent();
    expect(flagIds(pruneReviewFlags(flags, content, sampleContent()))).toEqual([
      'flag-bullet',
      'flag-exp',
      'flag-summary',
    ]);
  });

  it('drops a bullet flag when the bullet text changed', () => {
    const after = sampleContent();
    after.experience[0]!.bullets[1]!.text = 'Cut p99 latency significantly.';
    expect(flagIds(pruneReviewFlags(flags, sampleContent(), after))).toEqual([
      'flag-exp',
      'flag-summary',
    ]);
  });

  it('drops a flag whose target no longer exists', () => {
    const after = sampleContent();
    after.experience[0]!.bullets.pop();
    expect(flagIds(pruneReviewFlags(flags, sampleContent(), after))).not.toContain('flag-bullet');
  });

  it('drops an entry flag when one of its own fields changed, not when a bullet did', () => {
    const bulletEdited = sampleContent();
    bulletEdited.experience[0]!.bullets[0]!.text = 'Rewrote the billing service.';
    expect(flagIds(pruneReviewFlags(flags, sampleContent(), bulletEdited))).toContain('flag-exp');

    const titleEdited = sampleContent();
    titleEdited.experience[0]!.title = 'Senior Backend Engineer';
    expect(flagIds(pruneReviewFlags(flags, sampleContent(), titleEdited))).not.toContain(
      'flag-exp',
    );
  });

  it('drops summary and headline flags when that text changed', () => {
    const withHeadlineFlag = [...flags, { id: 'flag-headline', itemId: 'headline', reason: 'x' }];
    const after = sampleContent();
    after.summary = 'A new summary.';
    after.contact.headline = 'Staff Engineer';
    expect(flagIds(pruneReviewFlags(withHeadlineFlag, sampleContent(), after))).toEqual([
      'flag-bullet',
      'flag-exp',
    ]);
  });

  it('drops dismissed flags and flags pointing at unknown targets', () => {
    const withStale = [...flags, { id: 'flag-stale', itemId: 'gone', reason: 'x' }];
    const content = sampleContent();
    expect(flagIds(pruneReviewFlags(withStale, content, content, new Set(['flag-exp'])))).toEqual([
      'flag-bullet',
      'flag-summary',
    ]);
  });

  it('drops all flags when there is no content', () => {
    expect(pruneReviewFlags(flags, null, null)).toEqual([]);
  });
});
