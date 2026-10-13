import type { DataSource } from 'typeorm';
import { CvQuestionEntity, JobEntity, type CvEntity } from '../../src/db/entities/index.js';
import type { JobStatus, JobType } from '../../src/db/entities/job.entity.js';
import { CvRepository, type NewCv } from '../../src/modules/cvs/cv.repository.js';
import type { QuestionSection, QuestionStatus } from '../../src/modules/cvs/cv.types.js';
import { sampleContent, sampleReview } from '../fixtures/cv-content.js';

export async function createCv(
  dataSource: DataSource,
  userId: string,
  overrides: Partial<NewCv> = {},
): Promise<CvEntity> {
  return new CvRepository(dataSource.manager).create({
    userId,
    title: 'Senior Backend Engineer CV',
    targetRole: 'Senior Backend Engineer',
    sourceType: 'text',
    sourceText: 'Jane Doe. Backend engineer at Acme Payments since March 2021...',
    status: 'ready',
    stage: 'done',
    content: sampleContent(),
    review: sampleReview(),
    ...overrides,
  });
}

let questionPosition = 0;

export async function createQuestion(
  dataSource: DataSource,
  cvId: string,
  overrides: Partial<{
    section: QuestionSection;
    itemId: string | null;
    question: string;
    answer: string | null;
    status: QuestionStatus;
    error: string | null;
    position: number;
  }> = {},
): Promise<CvQuestionEntity> {
  questionPosition += 1;
  const repo = dataSource.getRepository(CvQuestionEntity);
  return repo.save(
    repo.create({
      cvId,
      section: 'experience',
      itemId: 'exp-1',
      question: 'What was the size of the team you led at Acme Payments?',
      status: 'open',
      position: questionPosition,
      ...overrides,
    }),
  );
}

export async function createJob(
  dataSource: DataSource,
  cvId: string,
  overrides: Partial<{ type: JobType; status: JobStatus; questionId: string | null }> = {},
): Promise<JobEntity> {
  const repo = dataSource.getRepository(JobEntity);
  return repo.save(repo.create({ cvId, type: 'generate_cv', status: 'queued', ...overrides }));
}
