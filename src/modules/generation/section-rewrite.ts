import { randomUUID } from 'node:crypto';
import {
  CV_CONTENT_LIMITS as L,
  type CvContent,
  type EducationItem,
  type ExperienceItem,
} from '../cvs/cv-content.schema.js';
import {
  HEADLINE_TARGET_ID,
  SUMMARY_TARGET_ID,
  type CvReview,
  type QuestionSection,
} from '../cvs/cv.types.js';
import type { Corpus } from '../grounding/corpus.js';
import {
  mergeReviews,
  verifyContact,
  verifyEducationItem,
  verifyExperienceItem,
  verifySkills,
  verifySummary,
  type ReviewScope,
} from '../grounding/verifier.js';
import { PermanentError } from '../jobs/job-errors.js';
import type { SectionRewrite, SectionSnapshot } from '../llm/llm-client.js';
import {
  clampLine,
  clampMultiline,
  sanitizeContactFields,
  sanitizeEducation,
  sanitizeExperience,
  sanitizeLinks,
  sanitizeQuotes,
  sanitizeSkillGroups,
  toValidContent,
  type Evidence,
  type IdFactory,
} from './draft-sanitizer.js';

/** The part of the CV a question is about. */
export interface RewriteTarget {
  section: QuestionSection;
  /** Experience/education entry; null for the section (or, there, for missing entries). */
  itemId: string | null;
}

export interface AppliedRewrite {
  content: CvContent;
  /** Verification result for the rewritten part only. */
  review: CvReview;
  /** Which existing review entries the part review replaces. */
  scope: ReviewScope;
}

const targetGone = () =>
  new PermanentError('INTERNAL', 'The CV entry this question is about no longer exists', {
    userMessage: 'The CV entry this question was about no longer exists.',
  });

function findEntry<T extends { id: string }>(items: readonly T[], itemId: string | null): T | null {
  if (itemId === null) return null;
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) throw targetGone();
  return item;
}

function withoutId<T extends { id: string }>({ id: _id, ...fields }: T): Omit<T, 'id'> {
  return fields;
}

/** What the model sees of the targeted part: plain values, no ids. */
export function sectionSnapshot(content: CvContent, target: RewriteTarget): SectionSnapshot {
  switch (target.section) {
    case 'contact': {
      const { fullName, email, phone, location, links } = content.contact;
      return {
        section: 'contact',
        current: {
          fullName,
          email,
          phone,
          location,
          links: links.map(({ label, url }) => ({ label, url })),
        },
      };
    }
    case 'summary':
      return {
        section: 'summary',
        current: { headline: content.contact.headline, summary: content.summary },
      };
    case 'experience': {
      const item = findEntry(content.experience, target.itemId);
      return {
        section: 'experience',
        current: {
          items: item
            ? [
                {
                  company: item.company,
                  title: item.title,
                  location: item.location,
                  startDate: item.startDate,
                  endDate: item.endDate,
                  bullets: item.bullets.map((bullet) => bullet.text),
                },
              ]
            : [],
        },
      };
    }
    case 'education': {
      const item = findEntry(content.education, target.itemId);
      return { section: 'education', current: { items: item ? [withoutId(item)] : [] } };
    }
    case 'skills':
      return {
        section: 'skills',
        current: { groups: content.skills.map(({ name, items }) => ({ name, items })) },
      };
  }
}

const noScope = (): ReviewScope => ({ targetIds: new Set(), removedFields: [] });

/**
 * Applies the model's rewrite of one part and re-verifies only that part. Ids stay stable:
 * the entry keeps its id, unchanged bullets keep theirs, links and skill groups are matched by
 * URL / name, so flags and evidence elsewhere stay valid.
 */
export function applySectionRewrite(
  content: CvContent,
  target: RewriteTarget,
  rewrite: SectionRewrite,
  corpus: Corpus,
  newId: IdFactory = randomUUID,
): AppliedRewrite {
  if (rewrite.section !== target.section) {
    throw new PermanentError(
      'LLM_INVALID_OUTPUT',
      `Rewrite for section "${rewrite.section}" does not match "${target.section}"`,
    );
  }
  const evidence: Evidence = {};

  switch (rewrite.section) {
    case 'contact': {
      const linkIds = new Map(content.contact.links.map((link) => [link.url, link.id]));
      const verified = verifyContact(
        {
          ...sanitizeContactFields(rewrite.data),
          headline: content.contact.headline,
          links: sanitizeLinks(rewrite.data.links, (url) => linkIds.get(url) ?? newId()),
        },
        corpus,
      );
      return {
        content: toValidContent({ ...content, contact: verified.contact }),
        review: verified.review,
        scope: { targetIds: new Set(), removedFields: ['contact'] },
      };
    }

    case 'summary': {
      // An empty value from the model would silently erase the user's text: keep the old one.
      const headline = clampLine(rewrite.data.headline, L.text) || content.contact.headline;
      const summary = clampMultiline(rewrite.data.summary.text, L.summary) || content.summary;
      evidence[SUMMARY_TARGET_ID] = sanitizeQuotes(rewrite.data.summary.evidence);
      const next = toValidContent({
        ...content,
        summary,
        contact: { ...content.contact, headline },
      });
      return {
        content: next,
        review: verifySummary(next, evidence, corpus),
        scope: {
          targetIds: new Set([SUMMARY_TARGET_ID, HEADLINE_TARGET_ID]),
          removedFields: [],
        },
      };
    }

    case 'experience': {
      const existing = findEntry(content.experience, target.itemId);
      if (existing) {
        const updated = rewriteEntry(existing, rewrite.data.items[0], evidence, newId);
        const next = toValidContent({
          ...content,
          experience: content.experience.map((item) => (item.id === existing.id ? updated : item)),
        });
        return {
          content: next,
          review: verifyExperienceItem(updated, evidence, corpus),
          scope: {
            targetIds: new Set([
              existing.id,
              ...existing.bullets.map((b) => b.id),
              ...updated.bullets.map((b) => b.id),
            ]),
            removedFields: [],
          },
        };
      }
      const known = new Set(content.experience.map((e) => entryKey(e.company, e.title)));
      const added = rewrite.data.items
        .map((draft) =>
          sanitizeExperience(draft, evidence, { itemId: newId(), bulletId: () => newId() }),
        )
        .filter((item): item is ExperienceItem => item !== null)
        // Asked for new entries only, the model may still repeat existing ones.
        .filter((item) => !known.has(entryKey(item.company, item.title)))
        .slice(0, L.experienceItems - content.experience.length);
      return {
        content: toValidContent({ ...content, experience: [...content.experience, ...added] }),
        review: mergeReviews(added.map((item) => verifyExperienceItem(item, evidence, corpus))),
        scope: noScope(),
      };
    }

    case 'education': {
      const existing = findEntry(content.education, target.itemId);
      if (existing) {
        const draft = rewrite.data.items[0];
        const updated = draft ? sanitizeEducation(draft, existing.id) : null;
        if (!updated) throw emptyRewrite();
        const next = toValidContent({
          ...content,
          education: content.education.map((item) => (item.id === existing.id ? updated : item)),
        });
        return {
          content: next,
          review: verifyEducationItem(updated, corpus),
          scope: { targetIds: new Set([existing.id]), removedFields: [] },
        };
      }
      const known = new Set(content.education.map((e) => entryKey(e.institution, e.degree)));
      const added = rewrite.data.items
        .map((draft) => sanitizeEducation(draft, newId()))
        .filter((item): item is EducationItem => item !== null)
        .filter((item) => !known.has(entryKey(item.institution, item.degree)))
        .slice(0, L.educationItems - content.education.length);
      return {
        content: toValidContent({ ...content, education: [...content.education, ...added] }),
        review: mergeReviews(added.map((item) => verifyEducationItem(item, corpus))),
        scope: noScope(),
      };
    }

    case 'skills': {
      const groupIds = new Map(content.skills.map((group) => [group.name.toLowerCase(), group.id]));
      const used = new Set<string>();
      const groups = sanitizeSkillGroups(rewrite.data.groups, (name) => {
        const known = groupIds.get(name.toLowerCase());
        const id = known && !used.has(known) ? known : newId();
        used.add(id);
        return id;
      });
      const verified = verifySkills(groups, corpus);
      return {
        content: toValidContent({ ...content, skills: verified.skills }),
        review: verified.review,
        scope: { targetIds: new Set(), removedFields: ['skills'] },
      };
    }
  }
}

/** Identity of an entry for duplicate detection: its two names, case-insensitively. */
const entryKey = (...names: string[]) => JSON.stringify(names.map((n) => n.toLowerCase()));

const emptyRewrite = () =>
  new PermanentError('LLM_INVALID_OUTPUT', 'The rewrite returned no usable entry');

/** The rewritten version of an existing entry: same id, unchanged bullets keep their ids. */
function rewriteEntry(
  existing: ExperienceItem,
  draft: Parameters<typeof sanitizeExperience>[0] | undefined,
  evidence: Evidence,
  newId: IdFactory,
): ExperienceItem {
  if (!draft) throw emptyRewrite();
  const bulletIds = new Map(existing.bullets.map((bullet) => [bullet.text, bullet.id]));
  const updated = sanitizeExperience(draft, evidence, {
    itemId: existing.id,
    bulletId: (text) => bulletIds.get(text) ?? newId(),
  });
  if (!updated) throw emptyRewrite();
  return updated;
}
