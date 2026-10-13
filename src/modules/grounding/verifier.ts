import { randomUUID } from 'node:crypto';
import type {
  CvContent,
  EducationItem,
  ExperienceItem,
  SkillGroup,
} from '../cvs/cv-content.schema.js';
import {
  HEADLINE_TARGET_ID,
  SUMMARY_TARGET_ID,
  type CvReview,
  type RemovedClaim,
  type ReviewFlag,
} from '../cvs/cv.types.js';
import type { Corpus } from './corpus.js';
import { normalizeText, wordsOf } from './normalize.js';
import { extractNumbers } from './numbers.js';

/*
 * Deterministic grounding checks (no LLM involved). Generated text is compared with the
 * corpus (source text + the user's answers):
 *   - unverifiable claims in prose (bullets, summary, entry names, dates) are FLAGGED, the user
 *     decides;
 *   - contact data and skills that are not in the corpus are REMOVED (and listed in
 *     review.removed), because they would otherwise be shown or printed as facts.
 */

/** Claimed supporting quotes per bullet id / 'summary', straight from the model. */
export type ClaimedEvidence = Readonly<Record<string, readonly string[]>>;

/** Share of an entry name's significant words that must appear in the corpus. */
export const MIN_ENTITY_WORD_SHARE = 0.6;

export const REASONS = {
  noEvidence: 'Could not find supporting text in your source',
  number: (raw: string) => `Number "${raw}" does not appear in your source`,
  entity: (label: string, value: string) => `${label} "${value}" was not found in your source`,
  seniority: (word: string) => `Title says "${word}", which your source does not`,
  email: 'Email address not found in your source',
  phone: 'Phone number not found in your source',
  link: 'Link not found in your source',
  name: 'Name not found in your source',
  location: 'Location not found in your source',
  skill: 'Skill not mentioned in your source',
} as const;

// Function words ignored when comparing entry names (English, German, French, Russian).
const STOPWORDS = new Set(
  (
    'a an and at for in of on the to with ' +
    'der die das und für von zu ' +
    'de des du et la le les ' +
    'в и на о по с для'
  ).split(' '),
);

// Seniority words: one invented "Senior" would otherwise pass the word-share threshold.
const SENIORITY_WORDS = new Set(
  (
    'junior senior lead principal staff head chief director manager vp cto cio ceo architect ' +
    'младший старший ведущий главный руководитель директор'
  ).split(' '),
);

/** Collects the review entries of one verification run. */
class ReviewBuilder {
  readonly flags: ReviewFlag[] = [];
  readonly removed: RemovedClaim[] = [];
  readonly evidence: Record<string, string[]> = {};

  flag(itemId: string, reason: string): void {
    if (this.flags.some((f) => f.itemId === itemId && f.reason === reason)) return;
    this.flags.push({ id: randomUUID(), itemId, reason });
  }

  remove(field: string, value: string, reason: string): void {
    this.removed.push({ field, value, reason });
  }

  build(): CvReview {
    return { flags: this.flags, removed: this.removed, evidence: this.evidence };
  }
}

function significantWords(value: string): string[] {
  return wordsOf(normalizeText(value)).filter(
    (word) => (word.length >= 2 || /\d/.test(word)) && !STOPWORDS.has(word),
  );
}

/** True when most significant words of `value` occur in the corpus (empty values pass). */
function mostlyInCorpus(value: string, corpus: Corpus): boolean {
  const words = significantWords(value);
  if (words.length === 0) return true;
  const found = words.filter((word) => corpus.hasWord(word)).length;
  return found / words.length >= MIN_ENTITY_WORD_SHARE;
}

function checkNumbers(text: string, itemId: string, corpus: Corpus, review: ReviewBuilder): void {
  for (const { raw, canonical } of extractNumbers(normalizeText(text))) {
    if (!corpus.hasNumber(canonical)) review.flag(itemId, REASONS.number(raw));
  }
}

/** Flags `itemId` unless at least one claimed quote is found; records the verified ones. */
function checkEvidence(
  itemId: string,
  claimed: readonly string[] | undefined,
  corpus: Corpus,
  review: ReviewBuilder,
): void {
  const verified = [...new Set(claimed ?? [])].filter((quote) => corpus.hasQuote(quote));
  if (verified.length === 0) review.flag(itemId, REASONS.noEvidence);
  else review.evidence[itemId] = verified;
}

function checkEntity(
  label: string,
  value: string,
  itemId: string,
  corpus: Corpus,
  review: ReviewBuilder,
): void {
  if (!mostlyInCorpus(value, corpus)) review.flag(itemId, REASONS.entity(label, value));
}

/** Like checkEntity, plus: no seniority word the source does not use ("Senior", "Lead"). */
function checkJobTitle(title: string, itemId: string, corpus: Corpus, review: ReviewBuilder) {
  if (!mostlyInCorpus(title, corpus)) {
    review.flag(itemId, REASONS.entity('Job title', title));
    return;
  }
  for (const word of significantWords(title)) {
    if (SENIORITY_WORDS.has(word) && !corpus.hasWord(word)) {
      review.flag(itemId, REASONS.seniority(word));
    }
  }
}

/** Contact fields that are not in the corpus are removed (they would be printed as facts). */
export function verifyContact(
  contact: CvContent['contact'],
  corpus: Corpus,
): { contact: CvContent['contact']; review: CvReview } {
  const review = new ReviewBuilder();
  const result = { ...contact };

  const fullNameWords = wordsOf(normalizeText(contact.fullName)).filter((w) => w.length >= 2);
  if (contact.fullName && !fullNameWords.every((word) => corpus.hasWord(word))) {
    review.remove('contact.fullName', contact.fullName, REASONS.name);
    result.fullName = '';
  }
  if (contact.email && !corpus.hasEmail(contact.email)) {
    review.remove('contact.email', contact.email, REASONS.email);
    result.email = '';
  }
  if (contact.phone && !corpus.hasPhone(contact.phone)) {
    review.remove('contact.phone', contact.phone, REASONS.phone);
    result.phone = '';
  }
  if (contact.location && !mostlyInCorpus(contact.location, corpus)) {
    review.remove('contact.location', contact.location, REASONS.location);
    result.location = '';
  }
  result.links = contact.links.filter((link) => {
    if (corpus.hasUrl(link.url)) return true;
    review.remove('contact.links', link.url, REASONS.link);
    return false;
  });
  return { contact: result, review: review.build() };
}

/** Summary needs evidence and no unknown numbers; the headline only no unknown numbers. */
export function verifySummary(
  content: Pick<CvContent, 'summary'> & { contact: Pick<CvContent['contact'], 'headline'> },
  claimed: ClaimedEvidence,
  corpus: Corpus,
): CvReview {
  const review = new ReviewBuilder();
  if (content.summary) {
    checkEvidence(SUMMARY_TARGET_ID, claimed[SUMMARY_TARGET_ID], corpus, review);
    checkNumbers(content.summary, SUMMARY_TARGET_ID, corpus, review);
  }
  checkNumbers(content.contact.headline, HEADLINE_TARGET_ID, corpus, review);
  return review.build();
}

export function verifyExperienceItem(
  item: ExperienceItem,
  claimed: ClaimedEvidence,
  corpus: Corpus,
): CvReview {
  const review = new ReviewBuilder();
  checkEntity('Company', item.company, item.id, corpus, review);
  checkJobTitle(item.title, item.id, corpus, review);
  checkEntity('Location', item.location, item.id, corpus, review);
  checkNumbers(`${item.startDate} ${item.endDate}`, item.id, corpus, review);
  for (const bullet of item.bullets) {
    checkEvidence(bullet.id, claimed[bullet.id], corpus, review);
    checkNumbers(bullet.text, bullet.id, corpus, review);
  }
  return review.build();
}

export function verifyEducationItem(item: EducationItem, corpus: Corpus): CvReview {
  const review = new ReviewBuilder();
  checkEntity('Institution', item.institution, item.id, corpus, review);
  checkEntity('Degree', item.degree, item.id, corpus, review);
  checkEntity('Location', item.location, item.id, corpus, review);
  checkNumbers(`${item.startDate} ${item.endDate} ${item.details}`, item.id, corpus, review);
  return review.build();
}

/** Skills not named in the corpus are removed; groups left empty are dropped. */
export function verifySkills(
  groups: readonly SkillGroup[],
  corpus: Corpus,
): { skills: SkillGroup[]; review: CvReview } {
  const review = new ReviewBuilder();
  const skills = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((skill) => {
        if (corpus.hasTerm(skill)) return true;
        review.remove('skills', skill, REASONS.skill);
        return false;
      }),
    }))
    .filter((group) => group.items.length > 0);
  return { skills, review: review.build() };
}

export function mergeReviews(reviews: readonly CvReview[]): CvReview {
  return {
    flags: reviews.flatMap((r) => r.flags),
    removed: reviews.flatMap((r) => r.removed),
    evidence: Object.assign({}, ...reviews.map((r) => r.evidence)) as CvReview['evidence'],
  };
}

/** Verifies a whole CV; returns the content with unsupported contact data and skills removed. */
export function verifyContent(
  content: CvContent,
  claimed: ClaimedEvidence,
  corpus: Corpus,
): { content: CvContent; review: CvReview } {
  const contact = verifyContact(content.contact, corpus);
  const skills = verifySkills(content.skills, corpus);
  const verified: CvContent = { ...content, contact: contact.contact, skills: skills.skills };
  const review = mergeReviews([
    contact.review,
    verifySummary(verified, claimed, corpus),
    ...verified.experience.map((item) => verifyExperienceItem(item, claimed, corpus)),
    ...verified.education.map((item) => verifyEducationItem(item, corpus)),
    skills.review,
  ]);
  return { content: verified, review };
}

/** Which review entries belong to one part of the CV (for re-verifying just that part). */
export interface ReviewScope {
  /** Flag targets / evidence keys of the part (old and new ids). */
  targetIds: ReadonlySet<string>;
  /** `RemovedClaim.field` prefixes of the part, e.g. 'contact' or 'skills'. */
  removedFields: readonly string[];
}

/** Replaces the part's flags, removed claims and evidence; everything else is kept. */
export function replaceReviewPart(
  review: CvReview | null,
  scope: ReviewScope,
  partReview: CvReview,
): CvReview {
  const base = review ?? { flags: [], removed: [], evidence: {} };
  const inScope = (field: string) =>
    scope.removedFields.some((prefix) => field === prefix || field.startsWith(`${prefix}.`));
  return {
    flags: [...base.flags.filter((f) => !scope.targetIds.has(f.itemId)), ...partReview.flags],
    removed: [...base.removed.filter((r) => !inScope(r.field)), ...partReview.removed],
    evidence: {
      ...Object.fromEntries(
        Object.entries(base.evidence).filter(([id]) => !scope.targetIds.has(id)),
      ),
      ...partReview.evidence,
    },
  };
}
