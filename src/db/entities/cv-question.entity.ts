import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { QuestionSection, QuestionStatus } from '../../modules/cvs/cv.types.js';
import { CvEntity } from './cv.entity.js';

@Entity({ name: 'cv_questions' })
export class CvQuestionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'cv_id', type: 'uuid' })
  cvId!: string;

  @ManyToOne(() => CvEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cv_id' })
  cv?: CvEntity;

  @Column({ type: 'text' })
  section!: QuestionSection;

  /** ExperienceItem.id / EducationItem.id when the question is about one entry. */
  @Column({ name: 'item_id', type: 'text', nullable: true })
  itemId!: string | null;

  @Column({ type: 'text' })
  question!: string;

  @Column({ type: 'text', nullable: true })
  answer!: string | null;

  @Column({ type: 'text', default: 'open' })
  status!: QuestionStatus;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  /** Display order within the CV (questions are returned ordered by position). */
  @Column({ type: 'integer' })
  position!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
