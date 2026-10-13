import type { DataSource } from 'typeorm';
import { AppError, validationError } from '../../http/errors.js';
import type { Logger } from '../../logger.js';
import { CvRepository, type NewCv } from '../cvs/cv.repository.js';
import type { CvService } from '../cvs/cv.service.js';
import type { CvDto } from '../cvs/cv.types.js';
import { enqueueJob } from '../jobs/job-queue.js';
import { assertGenerationCapacity } from './generation-capacity.js';
import { extractPdfText, isPdf, PdfUnreadableError } from './pdf-text.js';
import { countNonWhitespace, normalizeSourceText, SOURCE_LIMITS } from './source-text.js';
import { safeFilename } from './upload.js';

export interface CreateCvInput {
  targetRole: string;
  text?: string | undefined;
  file?: { buffer: Buffer; originalName: string | undefined } | undefined;
}

type PreparedSource = Pick<NewCv, 'sourceType' | 'sourceFilename' | 'sourceText' | 'sourcePdf'>;

const formatCount = (n: number) => n.toLocaleString('en');

/**
 * Validates and reads the source synchronously (so a bad upload fails with a 4xx right away),
 * then creates the CV and its generate_cv job in one transaction. The slow part runs in the
 * worker.
 */
export class IngestionService {
  constructor(
    private readonly deps: {
      dataSource: DataSource;
      cvService: CvService;
      maxActiveGenerations: number;
    },
  ) {}

  async createCv(userId: string, input: CreateCvInput, log: Logger): Promise<CvDto> {
    const source = await this.prepareSource(input, log);
    const cvId = await this.deps.dataSource.transaction(async (manager) => {
      await assertGenerationCapacity(manager, userId, this.deps.maxActiveGenerations);
      const cv = await new CvRepository(manager).create({
        userId,
        title: input.targetRole,
        targetRole: input.targetRole,
        ...source,
        status: 'generating',
        stage: 'queued',
      });
      await enqueueJob(manager, { type: 'generate_cv', cvId: cv.id });
      return cv.id;
    });
    return this.deps.cvService.get(userId, cvId);
  }

  private async prepareSource(input: CreateCvInput, log: Logger): Promise<PreparedSource> {
    const hasText = input.text !== undefined && input.text.trim() !== '';
    if (hasText === (input.file !== undefined)) {
      throw validationError([
        { path: hasText ? 'file' : 'text', message: 'Provide either a text or a PDF file' },
      ]);
    }
    return input.file ? this.readPdf(input.file, log) : this.readText(input.text ?? '');
  }

  private readText(raw: string): PreparedSource {
    const text = normalizeSourceText(raw);
    if (text.length < SOURCE_LIMITS.textMin) {
      throw new AppError(
        'UNPROCESSABLE_SOURCE',
        `The text is too short: at least ${SOURCE_LIMITS.textMin} characters are needed.`,
      );
    }
    if (text.length > SOURCE_LIMITS.textMax) {
      throw new AppError(
        'UNPROCESSABLE_SOURCE',
        `The text is too long: at most ${formatCount(SOURCE_LIMITS.textMax)} characters are supported.`,
      );
    }
    return { sourceType: 'text', sourceFilename: null, sourceText: text, sourcePdf: null };
  }

  private async readPdf(
    file: NonNullable<CreateCvInput['file']>,
    log: Logger,
  ): Promise<PreparedSource> {
    if (!isPdf(file.buffer)) {
      throw new AppError('UNSUPPORTED_FILE', 'Only PDF files are supported');
    }
    const sourceFilename = safeFilename(file.originalName);

    let extracted;
    try {
      extracted = await extractPdfText(file.buffer);
    } catch (err) {
      if (!(err instanceof PdfUnreadableError)) throw err;
      log.warn({ err }, 'PDF rejected');
      throw new AppError('UNPROCESSABLE_SOURCE', err.userMessage);
    }

    const text = normalizeSourceText(extracted.text);
    if (countNonWhitespace(text) < SOURCE_LIMITS.scannedThreshold) {
      // No usable text layer (a scan): keep the PDF; the job has Claude transcribe it.
      return { sourceType: 'pdf', sourceFilename, sourceText: null, sourcePdf: file.buffer };
    }
    const sourceText = withLinks(text, extracted.links);
    if (sourceText.length > SOURCE_LIMITS.extractedMax) {
      // Rejected rather than truncated: a cut-off CV would silently lose experience.
      throw new AppError(
        'UNPROCESSABLE_SOURCE',
        `This PDF contains too much text: at most ${formatCount(SOURCE_LIMITS.extractedMax)} characters are supported.`,
      );
    }
    return { sourceType: 'pdf', sourceFilename, sourceText, sourcePdf: null };
  }
}

/** Appends link targets that are not visible in the text (e.g. a "GitHub" label's URL). */
function withLinks(text: string, links: readonly string[]): string {
  const lower = text.toLowerCase();
  const hidden = links.filter((link) => !lower.includes(link.toLowerCase()));
  return hidden.length > 0 ? `${text}\n\nLinks:\n${hidden.join('\n')}` : text;
}
