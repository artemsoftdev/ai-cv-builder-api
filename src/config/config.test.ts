import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const DATABASE_URL = 'postgres://app:s3cret-password@db:5432/app';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ DATABASE_URL });
    expect(config).toEqual({
      nodeEnv: 'development',
      port: 4000,
      databaseUrl: DATABASE_URL,
      trustProxy: 'loopback, linklocal, uniquelocal',
      cookieSecure: false,
      logLevel: 'info',
      llm: { provider: 'anthropic', apiKey: undefined, model: 'claude-opus-5-5', effort: 'medium' },
      worker: { enabled: true, concurrency: 2 },
    });
  });

  it('treats empty values as unset (docker compose passes VAR= for undefined vars)', () => {
    const config = loadConfig({ DATABASE_URL, ANTHROPIC_API_KEY: '', PORT: ' ' });
    expect(config.llm.apiKey).toBeUndefined();
    expect(config.port).toBe(4000);
  });

  it('parses numbers and booleans', () => {
    const config = loadConfig({
      DATABASE_URL,
      PORT: '8080',
      WORKER_ENABLED: 'false',
      WORKER_CONCURRENCY: '4',
      COOKIE_SECURE: 'true',
      LLM_PROVIDER: 'fake',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_EFFORT: 'high',
    });
    expect(config.port).toBe(8080);
    expect(config.worker).toEqual({ enabled: false, concurrency: 4 });
    expect(config.cookieSecure).toBe(true);
    expect(config.llm).toMatchObject({ provider: 'fake', apiKey: 'sk-ant-test', effort: 'high' });
  });

  it.each([
    ['2', 2],
    ['true', true],
    ['false', false],
    ['10.0.0.0/8, loopback', '10.0.0.0/8, loopback'],
  ])('parses TRUST_PROXY=%j', (value, expected) => {
    expect(loadConfig({ DATABASE_URL, TRUST_PROXY: value }).trustProxy).toEqual(expected);
  });

  it('fails with a readable error naming every invalid variable', () => {
    const load = () =>
      loadConfig({
        DATABASE_URL: 'mysql://app:s3cret-password@db/app',
        PORT: 'eighty',
        LLM_PROVIDER: 'openai',
        WORKER_ENABLED: 'maybe',
      });
    expect(load).toThrow(ConfigError);
    try {
      load();
    } catch (err) {
      const message = (err as Error).message;
      for (const name of ['DATABASE_URL', 'PORT', 'LLM_PROVIDER', 'WORKER_ENABLED']) {
        expect(message).toContain(name);
      }
      expect(message).not.toContain('s3cret-password');
    }
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
