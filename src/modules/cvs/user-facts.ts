import type { CvContent } from './cv-content.schema.js';
import type { CvPatchInput, CvEditableState } from './cv-patch.js';
import { HEADLINE_TARGET_ID, SUMMARY_TARGET_ID } from './cv.types.js';

export const MAX_USER_FACTS = 300;
export const MAX_USER_FACTS_CHARS = 40_000;

const CONTACT_FIELDS = ['fullName', 'headline', 'email', 'phone', 'location'] as const;
const EXPERIENCE_FIELDS = ['company', 'title', 'location', 'startDate', 'endDate'] as const;
const EDUCATION_FIELDS = [
  'institution',
  'degree',
  'location',
  'startDate',
  'endDate',
  'details',
] as const;

function changedFields<T extends { id: string }, K extends keyof T>(
  before: readonly T[],
  after: readonly T[],
  fields: readonly K[],
  add: (value: string, previous: string | undefined) => void,
): void {
  const previous = new Map(before.map((item) => [item.id, item]));
  for (const item of after) {
    const old = previous.get(item.id);
    for (const field of fields) add(String(item[field]), old && String(old[field]));
  }
}

export function editedValues(before: CvContent, after: CvContent): string[] {
  const facts: string[] = [];
  const add = (value: string, previous: string | undefined) => {
    if (value.trim() !== '' && value !== previous) facts.push(value);
  };
  for (const field of CONTACT_FIELDS) add(after.contact[field], before.contact[field]);
  changedFields(before.contact.links, after.contact.links, ['label', 'url'], add);
  add(after.summary, before.summary);
  changedFields(before.experience, after.experience, EXPERIENCE_FIELDS, add);
  changedFields(
    before.experience.flatMap((item) => item.bullets),
    after.experience.flatMap((item) => item.bullets),
    ['text'],
    add,
  );
  changedFields(before.education, after.education, EDUCATION_FIELDS, add);
  const knownSkills = new Set(before.skills.flatMap((g) => g.items.map((s) => s.toLowerCase())));
  for (const skill of after.skills.flatMap((group) => group.items)) {
    if (!knownSkills.has(skill.toLowerCase())) add(skill, undefined);
  }
  return facts;
}

export function targetTexts(content: CvContent, itemId: string): string[] {
  if (itemId === SUMMARY_TARGET_ID) return [content.summary];
  if (itemId === HEADLINE_TARGET_ID) return [content.contact.headline];
  for (const item of content.experience) {
    if (item.id === itemId) return EXPERIENCE_FIELDS.map((field) => item[field]);
    const bullet = item.bullets.find((candidate) => candidate.id === itemId);
    if (bullet) return [bullet.text];
  }
  const education = content.education.find((item) => item.id === itemId);
  return education ? EDUCATION_FIELDS.map((field) => education[field]) : [];
}

/** Edited values and the targets of dismissed flags. */
export function confirmedFacts(current: CvEditableState, input: CvPatchInput): string[] {
  if (!current.content) return [];
  const content = current.content;
  const edited = input.content ? editedValues(content, input.content) : [];
  const dismissed = new Set(input.dismissFlagIds ?? []);
  const confirmed = (current.review?.flags ?? [])
    .filter((flag) => dismissed.has(flag.id))
    .flatMap((flag) => targetTexts(content, flag.itemId));
  return [...edited, ...confirmed].filter((text) => text.trim() !== '');
}

export function mergeUserFacts(existing: readonly string[], added: readonly string[]): string[] {
  const newestFirst = [...new Set([...added].reverse().concat([...existing].reverse()))];
  const kept: string[] = [];
  let chars = 0;
  for (const fact of newestFirst) {
    if (kept.length === MAX_USER_FACTS || chars + fact.length > MAX_USER_FACTS_CHARS) break;
    kept.push(fact);
    chars += fact.length;
  }
  return kept.reverse();
}
