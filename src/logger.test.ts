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

  it('drops row values that Postgres puts into constraint error details', () => {
    const { logger, entries } = capture();
    const driverError = Object.assign(new Error('violates check constraint'), {
      detail: 'Failing row contains (cv-id, {"summary": "private CV text"})',
    });
    const err = Object.assign(new Error('violates check constraint'), {
      code: '23514',
      constraint: 'cvs_ready_has_content_chk',
      detail: driverError.detail,
      where: 'SQL statement "UPDATE cvs ..." with private CV text',
      driverError,
    });
    logger.error({ err: new Error('job failed', { cause: err }) }, 'Job failed');
    logger.error({ err }, 'Unhandled error');

    const output = JSON.stringify(entries());
    expect(output).not.toContain('private CV text');
    expect(output).toContain('cvs_ready_has_content_chk');
  });
});
