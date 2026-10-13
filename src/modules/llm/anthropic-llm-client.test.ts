import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/config.js';
import { createLogger } from '../../logger.js';
import type { DraftCv } from '../generation/llm-output.schemas.js';
import { PermanentError } from '../jobs/job-errors.js';
import { AnthropicLlmClient, FALLBACK_BETA, finalText } from './anthropic-llm-client.js';

const CONFIG: AppConfig['llm'] = {
  provider: 'anthropic',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-5-5',
  effort: 'medium',
  fallbacks: true,
  fakeDelayMs: 0,
};

const DRAFT: DraftCv = {
  contact: {
    fullName: 'Jane',
    headline: 'Engineer',
    email: '',
    phone: '',
    location: '',
    links: [],
  },
  summary: { text: 'Engineer.', evidence: ['Engineer'] },
  experience: [],
  education: [],
  skills: [],
  questions: [],
};

type Content = BetaMessage['content'];

function message(stopReason: string, content: Content): BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_details: stopReason === 'refusal' ? { category: 'cyber' } : null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as BetaMessage;
}

const text = (value: string) => ({ type: 'text', text: value }) as Content[number];

function setup(responses: BetaMessage[], config: Partial<AppConfig['llm']> = {}) {
  const create = vi.fn();
  for (const response of responses) create.mockResolvedValueOnce(response);
  const sdk = { beta: { messages: { create } } } as unknown as Anthropic;
  const client = new AnthropicLlmClient({ ...CONFIG, ...config }, createLogger('silent'), sdk);
  return { client, create };
}

const INPUT = { sourceText: 'Jane, Engineer', targetRole: 'Backend Engineer' };

describe('AnthropicLlmClient.draftCv', () => {
  it('requests structured output with effort, a cached system prompt and the fallback beta', async () => {
    const { client, create } = setup([message('end_turn', [text(JSON.stringify(DRAFT))])]);
    await expect(client.draftCv(INPUT)).resolves.toEqual(DRAFT);

    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
    });
    // Thinking is always on for this model; sending a config for it would be a 400.
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('tool_choice');
    const userContent = (params.messages as { content: string }[])[0]!.content;
    expect(userContent).toContain('<source_document>\nJane, Engineer\n</source_document>');
  });

  it('can switch the server-side fallback off', async () => {
    const { client, create } = setup([message('end_turn', [text(JSON.stringify(DRAFT))])], {
      fallbacks: false,
    });
    await client.draftCv(INPUT);
    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params).not.toHaveProperty('betas');
    expect(params).not.toHaveProperty('fallbacks');
  });

  it('treats a refusal as permanent LLM_REFUSED', async () => {
    const { client } = setup([message('refusal', [])]);
    await expect(client.draftCv(INPUT)).rejects.toMatchObject({
      name: 'PermanentError',
      code: 'LLM_REFUSED',
    });
  });

  it('retries once with a larger budget when the output was cut off', async () => {
    const { client, create } = setup([
      message('max_tokens', [text('{"contact":')]),
      message('end_turn', [text(JSON.stringify(DRAFT))]),
    ]);
    await expect(client.draftCv(INPUT)).resolves.toEqual(DRAFT);
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1] as [{ max_tokens: number }])[0].max_tokens).toBe(32_000);
  });

  it('fails with LLM_INVALID_OUTPUT when the output is cut off twice', async () => {
    const { client } = setup([
      message('max_tokens', [text('{')]),
      message('max_tokens', [text('{')]),
    ]);
    await expect(client.draftCv(INPUT)).rejects.toMatchObject({ code: 'LLM_INVALID_OUTPUT' });
  });

  it('rejects output that is not valid JSON or does not match the schema', async () => {
    const notJson = setup([message('end_turn', [text('Sure! Here is your CV')])]);
    await expect(notJson.client.draftCv(INPUT)).rejects.toMatchObject({
      code: 'LLM_INVALID_OUTPUT',
    });
    const wrongShape = setup([message('end_turn', [text('{"contact": {}}')])]);
    await expect(wrongShape.client.draftCv(INPUT)).rejects.toMatchObject({
      code: 'LLM_INVALID_OUTPUT',
    });
  });

  it('reads the answer after a server-side fallback block', async () => {
    const fallback = {
      type: 'fallback',
      from: { model: 'claude-opus-5-5' },
      to: { model: 'claude-opus-5' },
    } as unknown as Content[number];
    const { client } = setup([message('end_turn', [fallback, text(JSON.stringify(DRAFT))])]);
    await expect(client.draftCv(INPUT)).resolves.toEqual(DRAFT);
  });

  it('fails permanently with LLM_NOT_CONFIGURED without an API key', async () => {
    const client = new AnthropicLlmClient({ ...CONFIG, apiKey: undefined }, createLogger('silent'));
    const error = await client.draftCv(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PermanentError);
    expect(error).toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
  });

  it('passes the abort signal to the SDK and surfaces its reason', async () => {
    const controller = new AbortController();
    const reason = new Error('worker stopping');
    const create = vi.fn().mockImplementation(() => {
      controller.abort(reason);
      return Promise.reject(new Error('Request was aborted.'));
    });
    const sdk = { beta: { messages: { create } } } as unknown as Anthropic;
    const client = new AnthropicLlmClient(CONFIG, createLogger('silent'), sdk);
    await expect(client.draftCv(INPUT, { signal: controller.signal })).rejects.toBe(reason);
    expect((create.mock.calls[0] as [unknown, { signal: AbortSignal }])[1].signal).toBe(
      controller.signal,
    );
  });
});

describe('AnthropicLlmClient.transcribePdf', () => {
  it('sends the PDF as a base64 document block before the instruction, without a schema', async () => {
    const { client, create } = setup([message('end_turn', [text('Jane Doe\nEngineer')])]);
    await expect(client.transcribePdf(Buffer.from('%PDF-1.7 test'))).resolves.toBe(
      'Jane Doe\nEngineer',
    );
    const [params] = create.mock.calls[0] as [
      { messages: { content: { type: string; source?: { data: string } }[] }[] },
    ];
    const blocks = params.messages[0]!.content;
    expect(blocks.map((b) => b.type)).toEqual(['document', 'text']);
    expect(blocks[0]!.source).toMatchObject({
      type: 'base64',
      media_type: 'application/pdf',
      data: Buffer.from('%PDF-1.7 test').toString('base64'),
    });
    expect(params).toMatchObject({ output_config: { effort: 'low' } });
    expect(params).not.toHaveProperty('output_config.format');
  });
});

describe('finalText', () => {
  it('joins the text blocks after the last fallback marker', () => {
    expect(
      finalText({
        content: [
          text('partial'),
          { type: 'fallback' } as unknown as Content[number],
          text('a'),
          text('b'),
        ],
      }),
    ).toBe('ab');
  });
});
