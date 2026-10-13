import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CvEntity } from './cv.entity.js';
import { CvQuestionEntity } from './cv-question.entity.js';

export const JOB_TYPES = ['generate_cv', 'apply_answer'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A CV is "busy" while it has a job in one of these states (at most one, see migration). */
export const ACTIVE_JOB_STATUSES = ['queued', 'running'] as const satisfies JobStatus[];

@Entity({ name: 'jobs' })
export class JobEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  type!: JobType;

  @Column({ name: 'cv_id', type: 'uuid' })
  cvId!: string;

  @ManyToOne(() => CvEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cv_id' })
  cv?: CvEntity;

  /** Set for (and only for) apply_answer jobs. */
  @Column({ name: 'question_id', type: 'uuid', nullable: true })
  questionId!: string | null;

  @ManyToOne(() => CvQuestionEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'question_id' })
  question?: CvQuestionEntity | null;

  @Column({ type: 'text', default: 'queued' })
  status!: JobStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'max_attempts', type: 'integer', default: 3 })
  maxAttempts!: number;

  @Column({ name: 'run_at', type: 'timestamptz', default: () => 'now()' })
  runAt!: Date;

  @Column({ name: 'locked_by', type: 'text', nullable: true })
  lockedBy!: string | null;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}
