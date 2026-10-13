import type { CvContent } from './cv-content.schema.js';
import { HEADLINE_TARGET_ID, SUMMARY_TARGET_ID, type ReviewFlag } from './cv.types.js';

/**
 * Maps every flaggable target id to a fingerprint of the text the flag is about.
 * An entry's fingerprint covers its own fields but not its bullets, so editing a bullet does
 * not clear a flag about the company name.
 */
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

/**
 * Keeps only flags that still apply after an edit: the target must exist in the new content
 * with unchanged text, and the flag must not have been dismissed by the user.
 * (A flag that points at an unknown target is dropped too.)
 */
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
