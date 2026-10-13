import { z } from 'zod';

export const LLM_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type LlmEffort = (typeof LLM_EFFORTS)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'Must be a postgres:// URL' }),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  ANTHROPIC_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  ANTHROPIC_EFFORT: z.enum(LLM_EFFORTS).default('medium'),
  // Server-side refusal fallback (beta). On by default as Anthropic recommends; switch it off
  // if the API ever rejects it together with structured outputs.
  ANTHROPIC_FALLBACKS: z.stringbool().default(true),
  LLM_PROVIDER: z.enum(['anthropic', 'fake']).default('anthropic'),
  // Artificial delay per pipeline step of the fake LLM, so the progress UI can be observed.
  FAKE_LLM_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1_500),
  WORKER_ENABLED: z.stringbool().default(true),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  COOKIE_SECURE: z.stringbool().default(false),
  // Passed to Express "trust proxy". The browser reaches the API through the Next.js rewrite,
  // so the client IP (used by rate limits) comes from X-Forwarded-For set by that hop.
  TRUST_PROXY: z
    .string()
    .trim()
    .min(1)
    .default('loopback, linklocal, uniquelocal')
    .transform(parseTrustProxy),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  databaseUrl: string;
  /** Express "trust proxy": hop count, true/false, or a list of trusted addresses/subnets. */
  trustProxy: boolean | number | string;
  cookieSecure: boolean;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  llm: {
    provider: 'anthropic' | 'fake';
    /** undefined when not configured; never log this value. */
    apiKey: string | undefined;
    model: string;
    effort: LlmEffort;
    /** Opt into the server-side refusal fallback (`fallbacks: "default"`). */
    fallbacks: boolean;
    /** FakeLlmClient only: delay per call, in milliseconds. */
    fakeDelayMs: number;
  };
  worker: {
    enabled: boolean;
    concurrency: number;
  };
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates environment variables. Empty values are treated as unset, because
 * docker compose passes `VAR=` for variables that are not defined on the host.
 * Error messages name the variable but never echo its value (DATABASE_URL holds a password).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const e = result.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    trustProxy: e.TRUST_PROXY,
    cookieSecure: e.COOKIE_SECURE,
    logLevel: e.LOG_LEVEL,
    llm: {
      provider: e.LLM_PROVIDER,
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.ANTHROPIC_MODEL,
      effort: e.ANTHROPIC_EFFORT,
      fallbacks: e.ANTHROPIC_FALLBACKS,
      fakeDelayMs: e.FAKE_LLM_DELAY_MS,
    },
    worker: {
      enabled: e.WORKER_ENABLED,
      concurrency: e.WORKER_CONCURRENCY,
    },
  };
}
