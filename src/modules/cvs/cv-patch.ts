import { isDeepStrictEqual } from 'node:util';
import type { CvContent } from './cv-content.schema.js';
import type { CvReview } from './cv.types.js';
import { pruneReviewFlags } from './review-flags.js';

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

export type CvChanges = Partial<{ title: string; content: CvContent; review: CvReview }>;

/**
 * Pure merge rules for PATCH /api/cvs/:id. Returns only the fields that actually change, or
 * null when the request is a no-op (then the version must not be bumped).
 */
export function planCvPatch(current: CvEditableState, input: CvPatchInput): CvChanges | null {
  const changes: CvChanges = {};

  if (input.title !== undefined && input.title !== current.title) {
    changes.title = input.title;
  }
  // Deep comparison: autosave may resend identical content; that must not create a version.
  if (input.content !== undefined && !isDeepStrictEqual(input.content, current.content)) {
    changes.content = input.content;
  }
  if (current.review) {
    const flags = pruneReviewFlags(
      current.review.flags,
      current.content,
      changes.content ?? current.content,
      new Set(input.dismissFlagIds ?? []),
    );
    if (flags.length !== current.review.flags.length) {
      changes.review = { ...current.review, flags };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}
