import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { CvContent } from '../../modules/cvs/cv-content.schema.js';
import type {
  CvReview,
  CvStatus,
  GenerationStage,
  SourceType,
} from '../../modules/cvs/cv.types.js';
import { UserEntity } from './user.entity.js';

@Entity({ name: 'cvs' })
export class CvEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @Column({ type: 'text' })
  title!: string;

  @Column({ name: 'target_role', type: 'text' })
  targetRole!: string;

  @Column({ name: 'source_type', type: 'text' })
  sourceType!: SourceType;

  @Column({ name: 'source_filename', type: 'text', nullable: true })
  sourceFilename!: string | null;

  /** NULL only for a scanned PDF until it is transcribed. */
  @Column({ name: 'source_text', type: 'text', nullable: true, select: false })
  sourceText!: string | null;

  /** Kept only for a scanned PDF until it is transcribed. */
  @Column({ name: 'source_pdf', type: 'bytea', nullable: true, select: false })
  sourcePdf!: Buffer | null;

  @Column({ name: 'source_transcribed', type: 'boolean', default: false })
  sourceTranscribed!: boolean;

  /** Text the user typed or confirmed; grounds later answer rewrites. */
  @Column({ name: 'user_facts', type: 'jsonb', default: () => "'[]'::jsonb", select: false })
  userFacts!: string[];

  @Column({ type: 'text', default: 'generating' })
  status!: CvStatus;

  @Column({ type: 'text', default: 'queued' })
  stage!: GenerationStage;

  @Column({ name: 'error_code', type: 'text', nullable: true })
  errorCode!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  content!: CvContent | null;

  @Column({ type: 'jsonb', nullable: true })
  review!: CvReview | null;

  /** Not @VersionColumn: stage updates must not make the editor's version stale. */
  @Column({ type: 'integer', default: 1 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Raw SQL updates must set it explicitly. */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
