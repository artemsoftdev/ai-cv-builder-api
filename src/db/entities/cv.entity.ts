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

  /**
   * Extracted/pasted source text. NULL only for scanned PDFs until Claude has transcribed them.
   * Not selected by default: large, and only the generation pipeline needs it.
   */
  @Column({ name: 'source_text', type: 'text', nullable: true, select: false })
  sourceText!: string | null;

  /** Original PDF bytes, kept only for scanned PDFs until transcription. Not selected by default. */
  @Column({ name: 'source_pdf', type: 'bytea', nullable: true, select: false })
  sourcePdf!: Buffer | null;

  /** source_text is Claude's transcription of a scanned PDF. */
  @Column({ name: 'source_transcribed', type: 'boolean', default: false })
  sourceTranscribed!: boolean;

  /** Text the user typed or confirmed in the editor; grounds later answer rewrites. */
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

  /**
   * Optimistic-locking counter for content/title/review changes. Deliberately a plain column,
   * not @VersionColumn: TypeORM would bump that on every update (e.g. stage changes), which
   * would make the editor's version stale for no reason.
   */
  @Column({ type: 'integer', default: 1 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Set automatically by TypeORM updates; raw SQL updates must set it explicitly. */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
