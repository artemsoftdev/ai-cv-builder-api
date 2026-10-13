import { randomUUID } from 'node:crypto';
import { sanitizeLine, sanitizeMultiline } from '../../shared/text.js';
import {
  CV_CONTENT_LIMITS as L,
  cvContentSchema,
  linkUrlSchema,
  type Bullet,
  type CvContent,
  type EducationItem,
  type ExperienceItem,
  type SkillGroup,
} from '../cvs/cv-content.schema.js';
import { QUESTION_SECTIONS, SUMMARY_TARGET_ID, type QuestionSection } from '../cvs/cv.types.js';
import { PermanentError } from '../jobs/job-errors.js';
import type {
  DraftBullet,
  DraftCv,
  DraftEducation,
  DraftExperience,
  DraftLink,
  DraftQuestion,
  DraftSkillGroup,
} from './llm-output.schemas.js';

/*
 * Turns model output (untrusted) into content that satisfies the CV content schema: strings
 * are sanitised and clamped to the contract limits (clamping beats rejecting a whole draft
 * over one long bullet), empty items are dropped, ids are ours, and experience is ordered by
 * the model's relevance score in code rather than by trusting the array order.
 */

export const MAX_QUESTIONS = 8;
export const MAX_QUOTES_PER_ITEM = 3;
const QUESTION_MAX_CHARS = 500;
const DEFAULT_SKILL_GROUP_NAME = 'Skills';

export type IdFactory = () => string;

/** Unverified quotes the model gave, per bullet id / 'summary'. */
export type Evidence = Record<string, string[]>;

export interface NewQuestion {
  section: QuestionSection;
  itemId: string | null;
  question: string;
}

export interface SanitizedDraft {
  content: CvContent;
  claimedEvidence: Evidence;
  questions: NewQuestion[];
}

/** Cuts at `max` UTF-16 units without splitting a surrogate pair. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd();
}

export const clampLine = (value: string, max: number) => truncate(sanitizeLine(value), max);
export const clampMultiline = (value: string, max: number) =>
  truncate(sanitizeMultiline(value), max);

export function clampRelevance(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
}

export function sanitizeQuotes(quotes: readonly string[]): string[] {
  const cleaned = quotes.map((quote) => clampLine(quote, L.text)).filter(Boolean);
  return [...new Set(cleaned)].slice(0, MAX_QUOTES_PER_ITEM);
}

export function sanitizeBullets(
  bullets: readonly DraftBullet[],
  evidence: Evidence,
  bulletId: (text: string) => string,
): Bullet[] {
  const result: Bullet[] = [];
  for (const bullet of bullets) {
    const text = clampLine(bullet.text, L.bullet);
    if (!text || result.some((existing) => existing.text === text)) continue;
    const id = bulletId(text);
    result.push({ id, text });
    evidence[id] = sanitizeQuotes(bullet.evidence);
    if (result.length === L.bulletsPerItem) break;
  }
  return result;
}

/** Null when the entry has nothing worth keeping. */
export function sanitizeExperience(
  draft: DraftExperience,
  evidence: Evidence,
  ids: { itemId: string; bulletId: (text: string) => string },
): ExperienceItem | null {
  const item: ExperienceItem = {
    id: ids.itemId,
    company: clampLine(draft.company, L.text),
    title: clampLine(draft.title, L.text),
    location: clampLine(draft.location, L.text),
    startDate: clampLine(draft.startDate, L.text),
    endDate: clampLine(draft.endDate, L.text),
    bullets: sanitizeBullets(draft.bullets, evidence, ids.bulletId),
  };
  return item.company || item.title || item.bullets.length > 0 ? item : null;
}

export function sanitizeEducation(draft: DraftEducation, id: string): EducationItem | null {
  const item: EducationItem = {
    id,
    institution: clampLine(draft.institution, L.text),
    degree: clampLine(draft.degree, L.text),
    location: clampLine(draft.location, L.text),
    startDate: clampLine(draft.startDate, L.text),
    endDate: clampLine(draft.endDate, L.text),
    details: clampMultiline(draft.details, L.educationDetails),
  };
  return item.institution || item.degree || item.details ? item : null;
}

/** Deduplicates skills across groups (case-insensitively) and drops empty groups. */
export function sanitizeSkillGroups(
  groups: readonly DraftSkillGroup[],
  groupId: (name: string) => string,
): SkillGroup[] {
  const seen = new Set<string>();
  const result: SkillGroup[] = [];
  for (const group of groups) {
    const items: string[] = [];
    for (const raw of group.items) {
      const skill = clampLine(raw, L.text);
      const key = skill.toLowerCase();
      if (!skill || seen.has(key)) continue;
      seen.add(key);
      items.push(skill);
      if (items.length === L.skillsPerGroup) break;
    }
    if (items.length === 0) continue;
    const name = clampLine(group.name, L.text) || DEFAULT_SKILL_GROUP_NAME;
    result.push({ id: groupId(name), name, items });
    if (result.length === L.skillGroups) break;
  }
  return result;
}

/** Keeps only links with a safe scheme (http, https, mailto or none). */
export function sanitizeLinks(
  links: readonly DraftLink[],
  linkId: (url: string) => string,
): CvContent['contact']['links'] {
  const result: CvContent['contact']['links'] = [];
  for (const link of links) {
    const url = clampLine(link.url, L.text);
    if (!url || !linkUrlSchema.safeParse(url).success) continue;
    if (result.some((existing) => existing.url === url)) continue;
    const label = clampLine(link.label, L.text) || url;
    result.push({ id: linkId(url), label, url });
    if (result.length === L.links) break;
  }
  return result;
}

export function sanitizeContactFields(draft: {
  fullName: string;
  email: string;
  phone: string;
  location: string;
}) {
  return {
    fullName: clampLine(draft.fullName, L.text),
    email: clampLine(draft.email, L.text),
    phone: clampLine(draft.phone, L.text),
    location: clampLine(draft.location, L.text),
  };
}

function isQuestionSection(value: string): value is QuestionSection {
  return (QUESTION_SECTIONS as readonly string[]).includes(value);
}

/**
 * Maps the model's item indexes to our ids. Questions about an entry that does not exist (or
 * was dropped as empty) are dropped too: answering them could not update anything.
 */
export function sanitizeQuestions(
  questions: readonly DraftQuestion[],
  itemIds: { experience: ReadonlyMap<number, string>; education: ReadonlyMap<number, string> },
): NewQuestion[] {
  const result: NewQuestion[] = [];
  for (const draft of questions) {
    const section = draft.section.trim().toLowerCase();
    const question = clampLine(draft.question, QUESTION_MAX_CHARS);
    if (!question || !isQuestionSection(section)) continue;
    let itemId: string | null = null;
    if ((section === 'experience' || section === 'education') && draft.itemIndex !== null) {
      const id = itemIds[section].get(draft.itemIndex);
      if (id === undefined) continue;
      itemId = id;
    }
    if (result.some((existing) => existing.question === question)) continue;
    result.push({ section, itemId, question });
    if (result.length === MAX_QUESTIONS) break;
  }
  return result;
}

/** Validates assembled content with the same schema as manual edits. */
export function toValidContent(candidate: CvContent): CvContent {
  const parsed = cvContentSchema.safeParse(candidate);
  if (!parsed.success) {
    // Should be impossible after sanitising; if it happens it is our bug, not the user's.
    throw new PermanentError(
      'LLM_INVALID_OUTPUT',
      `Sanitised content failed validation: ${parsed.error.message.slice(0, 500)}`,
    );
  }
  return parsed.data;
}

export function sanitizeDraft(draft: DraftCv, newId: IdFactory = randomUUID): SanitizedDraft {
  const evidence: Evidence = {};

  const experience = draft.experience
    .map((item, index) => ({
      index,
      relevance: clampRelevance(item.relevance),
      item: sanitizeExperience(item, evidence, { itemId: newId(), bulletId: () => newId() }),
    }))
    .filter((entry): entry is typeof entry & { item: ExperienceItem } => entry.item !== null)
    // Array.prototype.sort is stable: equally relevant entries keep the model's order.
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, L.experienceItems);

  const education = draft.education
    .map((item, index) => ({ index, item: sanitizeEducation(item, newId()) }))
    .filter((entry): entry is typeof entry & { item: EducationItem } => entry.item !== null)
    .slice(0, L.educationItems);

  const summary = clampMultiline(draft.summary.text, L.summary);
  if (summary) evidence[SUMMARY_TARGET_ID] = sanitizeQuotes(draft.summary.evidence);

  const content = toValidContent({
    contact: {
      ...sanitizeContactFields(draft.contact),
      headline: clampLine(draft.contact.headline, L.text),
      links: sanitizeLinks(draft.contact.links, () => newId()),
    },
    summary,
    experience: experience.map((entry) => entry.item),
    education: education.map((entry) => entry.item),
    skills: sanitizeSkillGroups(draft.skills, () => newId()),
  });

  const questions = sanitizeQuestions(draft.questions, {
    experience: new Map(experience.map((entry) => [entry.index, entry.item.id])),
    education: new Map(education.map((entry) => [entry.index, entry.item.id])),
  });

  return { content, claimedEvidence: evidence, questions };
}
