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
import {
  collapseAbbreviations,
  normalizePhrase,
  normalizeText,
  sameWord,
  stripEdgePunctuation,
  wordsOf,
} from './normalize.js';
import { extractNumbers } from './numbers.js';

// Deterministic checks against the corpus: unsupported prose is FLAGGED for the user, contact
// data and skills that are not in the corpus are REMOVED (they would print as facts).

/** Claimed supporting quotes per bullet id / 'summary', straight from the model. */
export type ClaimedEvidence = Readonly<Record<string, readonly string[]>>;

/** Share of an entry name's significant words that must appear in the corpus. */
export const MIN_ENTITY_WORD_SHARE = 0.6;

export const REASONS = {
  noEvidence: 'Could not find supporting text in your source',
  number: (raw: string) => `Number "${raw}" does not appear in your source`,
  entity: (label: string, value: string) => `${label} "${value}" was not found in your source`,
  seniority: (word: string) => `Title says "${word}", which your source does not`,
  ownership: (word: string) => `Says "${word}", which your source does not`,
  terms: (terms: readonly string[]) =>
    `${terms.map((term) => `"${term}"`).join(', ')} ${terms.length === 1 ? 'does' : 'do'} not appear in your source`,
  degreeLevel: (word: string) => `Degree says "${word}", which your source does not`,
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

// "worked on" easily becomes "Led"; a claim word needs a word of its family (or stem) in the corpus.
const OWNERSHIP_FAMILIES: readonly { claims: string[]; support: string[]; stems?: string[] }[] = [
  { claims: ['led', 'leading'], support: ['lead', 'leads', 'leader', 'leadership'] },
  { claims: ['managed', 'managing'], support: ['manage', 'manages', 'manager', 'management'] },
  { claims: ['headed'], support: ['head'] },
  { claims: ['directed', 'directing'], support: ['director'] },
  { claims: ['supervised', 'supervising'], support: ['supervise', 'supervisor'] },
  { claims: ['oversaw', 'overseeing'], support: ['oversee', 'oversees'] },
  { claims: ['spearheaded', 'spearheading'], support: ['spearhead'] },
  { claims: ['architected'], support: ['architect'] },
  { claims: ['owned', 'owning'], support: ['owner', 'ownership'] },
  { claims: ['drove'], support: ['drive', 'driven', 'driver'] },
  { claims: ['founded', 'cofounded'], support: ['founder', 'cofounder'] },
  { claims: ['mentored', 'mentoring'], support: ['mentor', 'mentors'] },
  { claims: ['championed'], support: ['champion'] },
  { claims: ['orchestrated'], support: ['orchestrate'] },
  { claims: ['leitete', 'leitet'], support: ['leiter', 'leitung', 'leiten'] },
  {
    claims: ['руководил', 'руководила', 'руководили', 'руководство'],
    support: [],
    stems: ['руковод'],
  },
  {
    claims: ['возглавлял', 'возглавляла', 'возглавил', 'возглавила', 'возглавляли'],
    support: [],
    stems: ['возглав'],
  },
  { claims: ['управлял', 'управляла', 'управляли'], support: [], stems: ['управл'] },
];
const OWNERSHIP_CLAIMS = new Map(
  OWNERSHIP_FAMILIES.flatMap((family) => family.claims.map((claim) => [claim, family] as const)),
);

const DEGREE_LEVELS: readonly (readonly string[])[] = [
  ['bachelor', 'bachelors', 'bsc', 'ba', 'bs', 'beng', 'bba', 'бакалавр'],
  ['master', 'masters', 'msc', 'ma', 'ms', 'meng', 'magister', 'магистр'],
  ['mba'],
  ['phd', 'doctor', 'doctorate', 'dphil', 'доктор', 'кандидат'],
  ['diploma', 'diplom', 'диплом', 'специалист'],
  ['associate'],
];

const NUMBER_LIKE_RE = /^\p{Sc}?[\d.,]+(?:[x×%kmb]|bn|mn|mln)?$/iu;

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

function mostlyInCorpus(value: string, corpus: Corpus): boolean {
  const words = significantWords(value);
  if (words.length === 0) return true;
  const found = words.filter((word) => corpus.hasWordLike(word)).length;
  return found / words.length >= MIN_ENTITY_WORD_SHARE;
}

function checkNumbers(text: string, itemId: string, corpus: Corpus, review: ReviewBuilder): void {
  for (const { raw, canonical } of extractNumbers(normalizeText(text))) {
    if (!corpus.hasNumber(canonical)) review.flag(itemId, REASONS.number(raw));
  }
}

/** A quote must share a significant word with the claim it supports. */
function supports(quote: string, claimWords: readonly string[]): boolean {
  return significantWords(quote).some((word) => claimWords.some((claim) => sameWord(word, claim)));
}

/**
 * Flags `itemId` unless a claimed quote occurs in the corpus and relates to `text`; records the
 * verified quotes. Text the user typed or confirmed needs no quote.
 */
function checkEvidence(
  itemId: string,
  text: string,
  claimed: readonly string[] | undefined,
  corpus: Corpus,
  review: ReviewBuilder,
): void {
  if (corpus.isConfirmed(text)) return;
  const claimWords = significantWords(text);
  const verified = [...new Set(claimed ?? [])].filter(
    (quote) => corpus.hasQuote(quote) && supports(quote, claimWords),
  );
  if (verified.length === 0) review.flag(itemId, REASONS.noEvidence);
  else review.evidence[itemId] = verified;
}

function checkOwnershipClaims(
  text: string,
  itemId: string,
  corpus: Corpus,
  review: ReviewBuilder,
): void {
  const words = wordsOf(normalizeText(text));
  words.forEach((word, i) => {
    const family = OWNERSHIP_CLAIMS.get(word);
    if (!family || (word === 'led' && words[i + 1] === 'to')) return;
    const supported =
      [...family.claims, ...family.support].some((form) => corpus.hasWordLike(form)) ||
      (family.stems ?? []).some((stem) => corpus.hasWordWithStem(stem));
    if (!supported) review.flag(itemId, REASONS.ownership(word));
  });
}

/**
 * Names and technologies the text mentions: capitalised words that do not start a sentence,
 * acronyms, tokens mixing letters with digits or + # . /, and any term of `vocabulary`.
 */
export function namedTerms(text: string, vocabulary: readonly string[] = []): string[] {
  const terms: string[] = [];
  let sentenceStart = true;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const atStart = sentenceStart;
    sentenceStart = /[.!?:;]["')\]]*$/.test(raw);
    const token = stripEdgePunctuation(raw).replace(/['’]s$/u, '');
    if (Array.from(token).length < 2 || NUMBER_LIKE_RE.test(token) || !/\p{L}/u.test(token)) {
      continue;
    }
    const technical = /\p{N}|[+#]|\p{L}[./]\p{L}/u.test(token);
    const capitalised = /\p{Lu}/u.test(token) && (!atStart || /\p{Lu}.*\p{Lu}/u.test(token));
    if (technical || capitalised) terms.push(token);
  }
  const normalized = normalizeText(text);
  for (const term of vocabulary) {
    const phrase = normalizePhrase(term);
    if (phrase.length >= 2 && ` ${normalized} `.includes(` ${phrase} `)) terms.push(term);
  }
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = normalizePhrase(term);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function termInCorpus(term: string, corpus: Corpus): boolean {
  if (corpus.hasTerm(term)) return true;
  const words = wordsOf(normalizePhrase(term));
  if (words.length !== 1) return false;
  return corpus.hasWordLike(words[0]!);
}

function checkNamedTerms(
  text: string,
  itemId: string,
  corpus: Corpus,
  review: ReviewBuilder,
  vocabulary: readonly string[],
): void {
  const missing = namedTerms(text, vocabulary).filter((term) => !termInCorpus(term, corpus));
  if (missing.length > 0) review.flag(itemId, REASONS.terms(missing.slice(0, 5)));
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
function checkJobTitle(
  label: string,
  title: string,
  itemId: string,
  corpus: Corpus,
  review: ReviewBuilder,
) {
  if (!mostlyInCorpus(title, corpus)) {
    review.flag(itemId, REASONS.entity(label, title));
    return;
  }
  for (const word of significantWords(title)) {
    if (SENIORITY_WORDS.has(word) && !corpus.hasWordLike(word)) {
      review.flag(itemId, REASONS.seniority(word));
    }
  }
}

/** A degree level ("Master", "PhD") needs the same level in the corpus, whatever the wording. */
function checkDegreeLevel(degree: string, itemId: string, corpus: Corpus, review: ReviewBuilder) {
  for (const word of wordsOf(collapseAbbreviations(normalizeText(degree)))) {
    const family = DEGREE_LEVELS.find((level) => level.some((form) => sameWord(word, form)));
    if (family && !family.some((form) => corpus.hasWordLike(form))) {
      review.flag(itemId, REASONS.degreeLevel(word));
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
  if (contact.fullName && !fullNameWords.every((word) => corpus.hasWordLike(word))) {
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

/** Summary: evidence, numbers, ownership verbs and named terms. Headline: a title the corpus backs. */
export function verifySummary(
  content: Pick<CvContent, 'summary'> & { contact: Pick<CvContent['contact'], 'headline'> },
  claimed: ClaimedEvidence,
  corpus: Corpus,
  vocabulary: readonly string[] = [],
): CvReview {
  const review = new ReviewBuilder();
  const { summary } = content;
  if (summary && !corpus.isConfirmed(summary)) {
    checkEvidence(SUMMARY_TARGET_ID, summary, claimed[SUMMARY_TARGET_ID], corpus, review);
    checkNumbers(summary, SUMMARY_TARGET_ID, corpus, review);
    checkOwnershipClaims(summary, SUMMARY_TARGET_ID, corpus, review);
    checkNamedTerms(summary, SUMMARY_TARGET_ID, corpus, review, vocabulary);
  }
  const { headline } = content.contact;
  if (headline && !corpus.isConfirmed(headline)) {
    checkNumbers(headline, HEADLINE_TARGET_ID, corpus, review);
    checkJobTitle('Headline', headline, HEADLINE_TARGET_ID, corpus, review);
  }
  return review.build();
}

export function verifyExperienceItem(
  item: ExperienceItem,
  claimed: ClaimedEvidence,
  corpus: Corpus,
  vocabulary: readonly string[] = [],
): CvReview {
  const review = new ReviewBuilder();
  checkEntity('Company', item.company, item.id, corpus, review);
  checkJobTitle('Job title', item.title, item.id, corpus, review);
  checkEntity('Location', item.location, item.id, corpus, review);
  checkNumbers(`${item.startDate} ${item.endDate}`, item.id, corpus, review);
  for (const bullet of item.bullets) {
    if (corpus.isConfirmed(bullet.text)) continue;
    checkEvidence(bullet.id, bullet.text, claimed[bullet.id], corpus, review);
    checkNumbers(bullet.text, bullet.id, corpus, review);
    checkOwnershipClaims(bullet.text, bullet.id, corpus, review);
    checkNamedTerms(bullet.text, bullet.id, corpus, review, vocabulary);
  }
  return review.build();
}

export function verifyEducationItem(
  item: EducationItem,
  corpus: Corpus,
  vocabulary: readonly string[] = [],
): CvReview {
  const review = new ReviewBuilder();
  checkEntity('Institution', item.institution, item.id, corpus, review);
  checkEntity('Degree', item.degree, item.id, corpus, review);
  checkDegreeLevel(item.degree, item.id, corpus, review);
  checkEntity('Location', item.location, item.id, corpus, review);
  checkNumbers(`${item.startDate} ${item.endDate}`, item.id, corpus, review);
  if (item.details && !corpus.isConfirmed(item.details)) {
    checkEntity('Details', item.details, item.id, corpus, review);
    checkNumbers(item.details, item.id, corpus, review);
    checkNamedTerms(item.details, item.id, corpus, review, vocabulary);
  }
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
  // Every skill the model listed, so a removed one is also caught in prose.
  const vocabulary = content.skills.flatMap((group) => group.items);
  const verified: CvContent = { ...content, contact: contact.contact, skills: skills.skills };
  const review = mergeReviews([
    contact.review,
    verifySummary(verified, claimed, corpus, vocabulary),
    ...verified.experience.map((item) => verifyExperienceItem(item, claimed, corpus, vocabulary)),
    ...verified.education.map((item) => verifyEducationItem(item, corpus, vocabulary)),
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
