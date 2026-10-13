// Loose on purpose: the sanitiser enforces the limits. Descriptions are prompt text.
import { z } from 'zod';
import { QUESTION_SECTIONS } from '../cvs/cv.types.js';

const evidence = z
  .array(z.string())
  .describe(
    '1-3 SHORT quotes (a few words each) copied character-for-character from the source ' +
      'document or the user answers that support this text',
  );

const field = (description: string) => z.string().describe(description);

export const draftBulletSchema = z.object({
  text: field('Concise achievement or responsibility, ideally <= 25 words, starts with a verb'),
  evidence,
});

export const draftExperienceSchema = z.object({
  company: field('Employer exactly as named in the source, or empty'),
  title: field('Job title exactly as in the source, or empty'),
  location: field('Location as in the source, or empty'),
  startDate: field('Start date exactly as written in the source, or empty'),
  endDate: field('End date exactly as written in the source (e.g. "Present"), or empty'),
  relevance: z.number().describe('0-100: how relevant this role is to the target role'),
  bullets: z.array(draftBulletSchema),
});

export const draftEducationSchema = z.object({
  institution: field('Institution exactly as named in the source, or empty'),
  degree: field('Degree / programme as in the source, or empty'),
  location: field('Location as in the source, or empty'),
  startDate: field('As written in the source, or empty'),
  endDate: field('As written in the source, or empty'),
  details: field('Honours, thesis etc. from the source, or empty'),
});

export const draftSkillGroupSchema = z.object({
  name: field('Group name, e.g. "Languages", "Frameworks", "Tools"'),
  items: z.array(z.string()).describe('Skills named in the source, one per entry'),
});

export const draftLinkSchema = z.object({
  label: field('Short label, e.g. "GitHub", "LinkedIn", "Portfolio"'),
  url: field('URL exactly as in the source'),
});

const contactFields = {
  fullName: field('Full name as in the source, or empty'),
  email: field('Email address from the source, or empty'),
  phone: field('Phone number from the source, or empty'),
  location: field('City / country of the candidate from the source, or empty'),
  links: z.array(draftLinkSchema),
};

const headline = field(
  'Short professional title for the CV header, aligned with the target role but true to the source',
);

const summary = z.object({
  text: field('2-4 sentences targeted at the role, using only facts from the source'),
  evidence,
});

export const draftQuestionSchema = z.object({
  // Not an enum: the SDK does not forward `enum`; the sanitiser drops unknown sections.
  section: field(`One of: ${QUESTION_SECTIONS.join(', ')}`),
  itemIndex: z
    .number()
    .nullable()
    .describe(
      '0-based index into the experience/education array when the question is about one ' +
        'entry; null for questions about the section as a whole or about missing entries',
    ),
  question: field('One specific question to the candidate'),
});

export const draftCvSchema = z.object({
  contact: z.object({ ...contactFields, headline }),
  summary,
  experience: z.array(draftExperienceSchema),
  education: z.array(draftEducationSchema),
  skills: z.array(draftSkillGroupSchema),
  questions: z.array(draftQuestionSchema).describe('At most 8 questions about gaps in the source'),
});

export const sectionRewriteSchemas = {
  contact: z.object(contactFields),
  summary: z.object({ headline, summary }),
  experience: z.object({ items: z.array(draftExperienceSchema) }),
  education: z.object({ items: z.array(draftEducationSchema) }),
  skills: z.object({ groups: z.array(draftSkillGroupSchema) }),
} as const;

export type DraftCv = z.output<typeof draftCvSchema>;
export type DraftBullet = z.output<typeof draftBulletSchema>;
export type DraftExperience = z.output<typeof draftExperienceSchema>;
export type DraftEducation = z.output<typeof draftEducationSchema>;
export type DraftSkillGroup = z.output<typeof draftSkillGroupSchema>;
export type DraftLink = z.output<typeof draftLinkSchema>;
export type DraftQuestion = z.output<typeof draftQuestionSchema>;

export type SectionRewriteMap = {
  [K in keyof typeof sectionRewriteSchemas]: z.output<(typeof sectionRewriteSchemas)[K]>;
};
