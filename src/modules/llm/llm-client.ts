import type { QuestionSection } from '../cvs/cv.types.js';
import type { DraftCv, SectionRewriteMap } from '../generation/llm-output.schemas.js';

/*
 * Domain-level LLM port. The generation pipeline only talks to this interface; the Anthropic
 * implementation turns it into Claude calls, the fake one into deterministic heuristics.
 * Implementations throw TransientError / PermanentError (modules/jobs/job-errors.ts) and, when
 * `signal` aborts, its reason.
 */

export interface LlmCallOptions {
  signal?: AbortSignal;
}

export interface DraftCvInput {
  /** Normalised source text (untrusted). */
  sourceText: string;
  targetRole: string;
}

export interface AnsweredQuestion {
  question: string;
  answer: string;
}

/** What the model sees of the section it rewrites. Ids stay with our code. */
export interface SectionSnapshotMap {
  contact: {
    fullName: string;
    email: string;
    phone: string;
    location: string;
    links: { label: string; url: string }[];
  };
  summary: { headline: string; summary: string };
  /** One entry (question about that entry) or none (question about missing entries). */
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
  /** The question being answered and its answer. */
  question: string;
  answer: string;
  /** Earlier answers to other questions about this CV (facts the user already provided). */
  priorAnswers: AnsweredQuestion[];
};

export interface LlmClient {
  /** Verbatim plain-text transcription of a PDF without a text layer (scanned). */
  transcribePdf(pdf: Buffer, options?: LlmCallOptions): Promise<string>;
  /** First CV draft with evidence quotes, relevance scores and questions. */
  draftCv(input: DraftCvInput, options?: LlmCallOptions): Promise<DraftCv>;
  /** Rewrites one section (or entry) to incorporate the user's answer. */
  rewriteSection(input: RewriteSectionInput, options?: LlmCallOptions): Promise<SectionRewrite>;
}
