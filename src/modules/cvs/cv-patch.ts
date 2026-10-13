import { isDeepStrictEqual } from 'node:util';
import type { CvContent } from './cv-content.schema.js';
import type { CvReview } from './cv.types.js';
import { pruneEvidence, pruneReviewFlags } from './review-flags.js';

export interface CvPatchInput {
  title?: string;
  content?: CvContent;
  dismissFlagIds?: string[];
}

export interface CvEditableState {
  title: string;
  content: CvContent | null;
  review: CvReview | null;
}

export type CvChanges = Partial<{
  title: string;
  content: CvContent;
  review: CvReview;
  userFacts: string[];
}>;

/** Only the fields that change, or null for a no-op (which must not bump the version). */
export function planCvPatch(current: CvEditableState, input: CvPatchInput): CvChanges | null {
  const changes: CvChanges = {};

  if (input.title !== undefined && input.title !== current.title) {
    changes.title = input.title;
  }
  if (input.content !== undefined && !isDeepStrictEqual(input.content, current.content)) {
    changes.content = input.content;
  }
  if (current.review) {
    const after = changes.content ?? current.content;
    const flags = pruneReviewFlags(
      current.review.flags,
      current.content,
      after,
      new Set(input.dismissFlagIds ?? []),
    );
    const evidence = pruneEvidence(current.review.evidence, current.content, after);
    const evidenceChanged =
      Object.keys(evidence).length !== Object.keys(current.review.evidence).length;
    if (flags.length !== current.review.flags.length || evidenceChanged) {
      changes.review = { ...current.review, flags, evidence };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}
