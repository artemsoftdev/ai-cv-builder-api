import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture() {
  const lines: string[] = [];
  const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
  return {
    logger,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('redacts cookies, credentials, personal file names and the API key', () => {
    const { logger, entries } = capture();
    logger.info(
      {
        req: { headers: { cookie: 'cvb_session=token', authorization: 'Bearer token' } },
        res: { headers: { 'content-disposition': 'attachment; filename="Jane Doe.pdf"' } },
        user: { password: 'hunter22', passwordHash: 'scrypt$...' },
        config: { llm: { apiKey: 'sk-ant-secret' } },
        llm: { apiKey: 'sk-ant-secret' },
      },
      'request',
    );
    const output = JSON.stringify(entries());
    expect(output).not.toMatch(/token|Jane Doe|hunter22|scrypt|sk-ant-secret/);
  });

  it('keeps SQL errors useful without their parameters', () => {
    const { logger, entries } = capture();
    const err = Object.assign(new Error('value too long'), {
      query: 'UPDATE cvs SET content = $1 WHERE id = $2',
      parameters: ['{"summary":"private CV text"}', 'cv-id'],
      code: '22001',
    });
    logger.error({ err }, 'Unhandled error');

    const [entry] = entries();
    expect(entry!.err).toMatchObject({
      message: 'value too long',
      query: 'UPDATE cvs SET content = $1 WHERE id = $2',
      code: '22001',
      parameters: '[redacted]',
    });
    expect(JSON.stringify(entry)).not.toContain('private CV text');
  });
});
