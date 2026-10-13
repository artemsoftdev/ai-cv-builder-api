import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { z } from 'zod';
import type { AppConfig, LlmEffort } from '../../config/config.js';
import type { Logger } from '../../logger.js';
import {
  draftCvSchema,
  sectionRewriteSchemas,
  type DraftCv,
} from '../generation/llm-output.schemas.js';
import {
  buildDraftPrompt,
  buildRewritePrompt,
  CV_SYSTEM_PROMPT,
  TRANSCRIBE_PROMPT,
  TRANSCRIBE_SYSTEM_PROMPT,
  type PromptParts,
} from '../generation/prompts.js';
import { PermanentError, TransientError } from '../jobs/job-errors.js';
import { toJobError } from './anthropic-errors.js';
import type {
  DraftCvInput,
  LlmCallOptions,
  LlmClient,
  RewriteSectionInput,
  SectionRewrite,
} from './llm-client.js';

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Streamed: this bounds only the wait for headers; the worker's deadline bounds the call.
const REQUEST_TIMEOUT_MS = 120_000;
const SDK_MAX_RETRIES = 1;

/** Thinking included; a response cut off at the limit is retried once with the larger budget. */
interface TokenBudget {
  maxTokens: number;
  retryMaxTokens: number;
}
const DRAFT_BUDGET: TokenBudget = { maxTokens: 16_000, retryMaxTokens: 32_000 };
const REWRITE_BUDGET: TokenBudget = { maxTokens: 8_000, retryMaxTokens: 16_000 };
const TRANSCRIBE_BUDGET: TokenBudget = { maxTokens: 16_000, retryMaxTokens: 32_000 };

interface Request {
  system: string;
  content: string | BetaContentBlockParam[];
  effort: LlmEffort;
  schema?: Record<string, unknown>;
}

const NOT_CONFIGURED_MESSAGE =
  'AI generation is not configured on the server (ANTHROPIC_API_KEY is missing).';

/** Not messages.parse(): stop_reason is checked first, or a refusal looks like bad JSON. */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic | null;

  constructor(
    private readonly config: AppConfig['llm'],
    private readonly logger: Logger,
    client?: Anthropic,
  ) {
    this.client =
      client ??
      (config.apiKey
        ? new Anthropic({
            apiKey: config.apiKey,
            maxRetries: SDK_MAX_RETRIES,
            timeout: REQUEST_TIMEOUT_MS,
          })
        : null);
  }

  async transcribePdf(pdf: Buffer, options: LlmCallOptions = {}): Promise<string> {
    return this.generateText(
      {
        system: TRANSCRIBE_SYSTEM_PROMPT,
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
          },
          { type: 'text', text: TRANSCRIBE_PROMPT },
        ],
        effort: 'low',
      },
      TRANSCRIBE_BUDGET,
      options,
    );
  }

  async draftCv(input: DraftCvInput, options: LlmCallOptions = {}): Promise<DraftCv> {
    return this.generateStructured(draftCvSchema, buildDraftPrompt(input), DRAFT_BUDGET, options);
  }

  async rewriteSection(
    input: RewriteSectionInput,
    options: LlmCallOptions = {},
  ): Promise<SectionRewrite> {
    const prompt = buildRewritePrompt(input);
    const run = <S extends z.ZodType>(schema: S) =>
      this.generateStructured(schema, prompt, REWRITE_BUDGET, options);
    switch (input.section) {
      case 'contact':
        return { section: 'contact', data: await run(sectionRewriteSchemas.contact) };
      case 'summary':
        return { section: 'summary', data: await run(sectionRewriteSchemas.summary) };
      case 'experience':
        return { section: 'experience', data: await run(sectionRewriteSchemas.experience) };
      case 'education':
        return { section: 'education', data: await run(sectionRewriteSchemas.education) };
      case 'skills':
        return { section: 'skills', data: await run(sectionRewriteSchemas.skills) };
    }
  }

  private async generateStructured<S extends z.ZodType>(
    schema: S,
    prompt: PromptParts,
    budget: TokenBudget,
    options: LlmCallOptions,
  ): Promise<z.output<S>> {
    const { schema: jsonSchema } = betaZodOutputFormat(schema);
    const content: BetaContentBlockParam[] = [
      { type: 'text', text: prompt.context, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: prompt.task },
    ];
    const text = await this.generateText(
      { system: CV_SYSTEM_PROMPT, content, effort: this.config.effort, schema: jsonSchema },
      budget,
      options,
    );
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // No `cause`: V8's SyntaxError quotes the input, i.e. CV content, and causes are logged.
      throw new TransientError('Structured output is not valid JSON', 'LLM_INVALID_OUTPUT');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new TransientError(
        `Structured output does not match the schema: ${parsed.error.message.slice(0, 500)}`,
        'LLM_INVALID_OUTPUT',
      );
    }
    return parsed.data;
  }

  private async generateText(
    request: Request,
    budget: TokenBudget,
    { signal }: LlmCallOptions,
  ): Promise<string> {
    let message = await this.send(request, budget.maxTokens, signal);
    if (message.stop_reason === 'max_tokens') {
      this.logger.warn(
        { maxTokens: budget.maxTokens, usage: message.usage },
        'Claude hit max_tokens, retrying once with a larger budget',
      );
      message = await this.send(request, budget.retryMaxTokens, signal);
    }

    switch (message.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
        break;
      case 'refusal':
        throw new PermanentError(
          'LLM_REFUSED',
          `Claude declined the request (category: ${message.stop_details?.category ?? 'unknown'})`,
        );
      case 'max_tokens':
        throw new PermanentError('LLM_INVALID_OUTPUT', 'Output exceeded the token budget twice', {
          userMessage: 'This source is too long for the AI to turn into a CV in one go.',
        });
      default:
        throw new PermanentError(
          'LLM_INVALID_OUTPUT',
          `Unexpected stop reason: ${message.stop_reason ?? 'none'}`,
        );
    }

    const text = finalText(message);
    if (text.trim() === '') {
      throw new TransientError('Claude returned no text', 'LLM_INVALID_OUTPUT');
    }
    return text;
  }

  private async send(request: Request, maxTokens: number, signal?: AbortSignal) {
    if (!this.client) {
      throw new PermanentError('LLM_NOT_CONFIGURED', 'ANTHROPIC_API_KEY is not set', {
        userMessage: NOT_CONFIGURED_MESSAGE,
      });
    }
    const params: BetaMessageStreamParams = {
      model: this.config.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: request.content }],
      output_config: {
        effort: request.effort,
        ...(request.schema ? { format: { type: 'json_schema', schema: request.schema } } : {}),
      },
      ...(this.config.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
    const startedAt = Date.now();
    try {
      const message = await this.client.beta.messages.stream(params, { signal }).finalMessage();
      this.logger.info(
        {
          model: message.model,
          stopReason: message.stop_reason,
          usage: message.usage,
          durationMs: Date.now() - startedAt,
        },
        'Claude call finished',
      );
      return message;
    } catch (err) {
      throw toJobError(err, signal);
    }
  }
}

/** Only text after the last `fallback` block belongs to the final answer. */
export function finalText(message: Pick<BetaMessage, 'content'>): string {
  const lastFallback = message.content.findLastIndex((block) => block.type === 'fallback');
  return message.content
    .slice(lastFallback + 1)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}
