import type { CvContent } from './cv-content.schema.js';
import {
  HEADLINE_TARGET_ID,
  SUMMARY_TARGET_ID,
  type CvReview,
  type ReviewFlag,
} from './cv.types.js';

/** An entry's fingerprint excludes its bullets: editing a bullet keeps a company-name flag. */
export function flagTargetFingerprints(content: CvContent | null): Map<string, string> {
  const targets = new Map<string, string>();
  if (!content) return targets;
  targets.set(SUMMARY_TARGET_ID, content.summary);
  targets.set(HEADLINE_TARGET_ID, content.contact.headline);
  for (const item of content.experience) {
    targets.set(
      item.id,
      JSON.stringify([item.company, item.title, item.location, item.startDate, item.endDate]),
    );
    for (const bullet of item.bullets) targets.set(bullet.id, bullet.text);
  }
  for (const item of content.education) {
    targets.set(
      item.id,
      JSON.stringify([
        item.institution,
        item.degree,
        item.location,
        item.startDate,
        item.endDate,
        item.details,
      ]),
    );
  }
  return targets;
}

/** Keeps flags whose target still exists unchanged and that were not dismissed. */
export function pruneReviewFlags(
  flags: readonly ReviewFlag[],
  before: CvContent | null,
  after: CvContent | null,
  dismissedFlagIds: ReadonlySet<string> = new Set(),
): ReviewFlag[] {
  const beforeTargets = flagTargetFingerprints(before);
  const afterTargets = after === before ? beforeTargets : flagTargetFingerprints(after);
  return flags.filter((flag) => {
    if (dismissedFlagIds.has(flag.id)) return false;
    const current = afterTargets.get(flag.itemId);
    return current !== undefined && current === beforeTargets.get(flag.itemId);
  });
}

export function pruneEvidence(
  evidence: CvReview['evidence'],
  before: CvContent | null,
  after: CvContent | null,
): CvReview['evidence'] {
  const beforeTargets = flagTargetFingerprints(before);
  const afterTargets = after === before ? beforeTargets : flagTargetFingerprints(after);
  return Object.fromEntries(
    Object.entries(evidence).filter(([id]) => {
      const current = afterTargets.get(id);
      return current !== undefined && current === beforeTargets.get(id);
    }),
  );
}
