import { setTimeout as sleep } from 'node:timers/promises';
import type { DraftCv } from '../generation/llm-output.schemas.js';
import { FAKE_TRANSCRIPTION, heuristicDraft, heuristicRewrite } from './fake-heuristics.js';
import type {
  DraftCvInput,
  LlmCallOptions,
  LlmClient,
  RewriteSectionInput,
  SectionRewrite,
} from './llm-client.js';

type MaybePromise<T> = T | Promise<T>;

/** Per-method replacements, e.g. a draft with deliberately invented facts, or a thrown error. */
export interface FakeLlmOverrides {
  transcribePdf?: (pdf: Buffer) => MaybePromise<string>;
  draftCv?: (input: DraftCvInput) => MaybePromise<DraftCv>;
  rewriteSection?: (input: RewriteSectionInput) => MaybePromise<SectionRewrite>;
}

export interface FakeLlmOptions {
  /** Artificial latency per call so the progress UI can be observed. Default 0. */
  delayMs?: number;
  overrides?: FakeLlmOverrides;
}

/**
 * Keyless LlmClient (LLM_PROVIDER=fake) for the local demo and tests: deterministic heuristics
 * that only copy text from the source, overridable per method.
 */
export class FakeLlmClient implements LlmClient {
  /** Mutable so a test can change behaviour between steps. */
  overrides: FakeLlmOverrides;
  readonly calls = { transcribePdf: 0, draftCv: 0, rewriteSection: 0 };
  private readonly delayMs: number;

  constructor(options: FakeLlmOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.overrides = options.overrides ?? {};
  }

  async transcribePdf(pdf: Buffer, options: LlmCallOptions = {}): Promise<string> {
    this.calls.transcribePdf++;
    await this.delay(options.signal);
    return this.overrides.transcribePdf ? this.overrides.transcribePdf(pdf) : FAKE_TRANSCRIPTION;
  }

  async draftCv(input: DraftCvInput, options: LlmCallOptions = {}): Promise<DraftCv> {
    this.calls.draftCv++;
    await this.delay(options.signal);
    return this.overrides.draftCv ? this.overrides.draftCv(input) : heuristicDraft(input);
  }

  async rewriteSection(
    input: RewriteSectionInput,
    options: LlmCallOptions = {},
  ): Promise<SectionRewrite> {
    this.calls.rewriteSection++;
    await this.delay(options.signal);
    return this.overrides.rewriteSection
      ? this.overrides.rewriteSection(input)
      : heuristicRewrite(input);
  }

  private async delay(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.delayMs <= 0) return;
    try {
      await sleep(this.delayMs, undefined, { signal });
    } catch (err) {
      // Surface the abort reason (lease lost / shutdown), like the real client does.
      throw signal?.aborted ? signal.reason : err;
    }
  }
}
