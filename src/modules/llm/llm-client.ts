import type { QuestionSection } from '../cvs/cv.types.js';
import type { DraftCv, SectionRewriteMap } from '../generation/llm-output.schemas.js';

// Implementations throw TransientError / PermanentError, or the signal's reason when aborted.

export interface LlmCallOptions {
  signal?: AbortSignal;
}

export interface DraftCvInput {
  sourceText: string;
  targetRole: string;
}

export interface AnsweredQuestion {
  question: string;
  answer: string;
}

/** What the model sees of the section it rewrites: values only, ids stay with our code. */
export interface SectionSnapshotMap {
  contact: {
    fullName: string;
    email: string;
    phone: string;
    location: string;
    links: { label: string; url: string }[];
  };
  summary: { headline: string; summary: string };
  /** Empty when the question is about missing entries. */
  experience: {
    items: {
      company: string;
      title: string;
      location: string;
      startDate: string;
      endDate: string;
      bullets: string[];
    }[];
  };
  education: {
    items: {
      institution: string;
      degree: string;
      location: string;
      startDate: string;
      endDate: string;
      details: string;
    }[];
  };
  skills: { groups: { name: string; items: string[] }[] };
}

type BySection<T extends Record<QuestionSection, unknown>, Key extends string> = {
  [K in QuestionSection]: { section: K } & Record<Key, T[K]>;
}[QuestionSection];

export type SectionSnapshot = BySection<SectionSnapshotMap, 'current'>;
export type SectionRewrite = BySection<SectionRewriteMap, 'data'>;

export type RewriteSectionInput = SectionSnapshot & {
  targetRole: string;
  sourceText: string;
  question: string;
  answer: string;
  priorAnswers: AnsweredQuestion[];
};

export interface LlmClient {
  transcribePdf(pdf: Buffer, options?: LlmCallOptions): Promise<string>;
  draftCv(input: DraftCvInput, options?: LlmCallOptions): Promise<DraftCv>;
  rewriteSection(input: RewriteSectionInput, options?: LlmCallOptions): Promise<SectionRewrite>;
}
