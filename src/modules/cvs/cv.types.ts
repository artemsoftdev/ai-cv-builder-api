// Contract types from docs/API.md, mirrored by the frontend.
import type { CvContent } from './cv-content.schema.js';

export type { CvContent };

export const CV_STATUSES = ['generating', 'ready', 'failed'] as const;
export type CvStatus = (typeof CV_STATUSES)[number];

export const GENERATION_STAGES = ['queued', 'extracting', 'drafting', 'verifying', 'done'] as const;
export type GenerationStage = (typeof GENERATION_STAGES)[number];

export const SOURCE_TYPES = ['pdf', 'text'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const QUESTION_SECTIONS = [
  'contact',
  'summary',
  'experience',
  'education',
  'skills',
] as const;
export type QuestionSection = (typeof QUESTION_SECTIONS)[number];

export const QUESTION_STATUSES = ['open', 'applying', 'applied', 'dismissed', 'failed'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const ACTIONABLE_QUESTION_STATUSES = ['open', 'failed'] as const satisfies QuestionStatus[];

export const SUMMARY_TARGET_ID = 'summary';
export const HEADLINE_TARGET_ID = 'headline';

export interface ReviewFlag {
  id: string;
  itemId: string;
  reason: string;
}

export interface RemovedClaim {
  field: string;
  value: string;
  reason: string;
}

export interface CvReview {
  flags: ReviewFlag[];
  removed: RemovedClaim[];
  evidence: Record<string, string[]>;
}

export interface CvQuestionDto {
  id: string;
  section: QuestionSection;
  itemId: string | null;
  question: string;
  answer: string | null;
  status: QuestionStatus;
  error: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CvSourceDto {
  type: SourceType;
  filename: string | null;
  /** `text` is Claude's transcription of a scanned PDF. */
  transcribed: boolean;
  text: string | null;
}

export interface CvDto {
  id: string;
  title: string;
  targetRole: string;
  sourceType: SourceType;
  sourceFilename: string | null;
  status: CvStatus;
  stage: GenerationStage;
  error: { code: string; message: string } | null;
  content: CvContent | null;
  review: CvReview | null;
  questions: CvQuestionDto[];
  version: number;
  busy: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CvSummaryDto = Pick<
  CvDto,
  'id' | 'title' | 'targetRole' | 'status' | 'stage' | 'busy' | 'createdAt' | 'updatedAt'
> & { openQuestions: number };
