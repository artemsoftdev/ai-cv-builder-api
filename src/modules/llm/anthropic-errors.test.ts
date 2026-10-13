import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { PermanentError, TransientError } from '../jobs/job-errors.js';
import { toJobError } from './anthropic-errors.js';

const headers = new Headers();
const body = (type: string) => ({ type: 'error', error: { type, message: 'details' } });

describe('toJobError', () => {
  it.each([
    ['429 rate limit', new Anthropic.RateLimitError(429, body('rate_limit_error'), 'x', headers)],
    ['500 api error', new Anthropic.InternalServerError(500, body('api_error'), 'x', headers)],
    [
      '529 overloaded',
      new Anthropic.InternalServerError(529, body('overloaded_error'), 'x', headers),
    ],
    ['connection error', new Anthropic.APIConnectionError({ message: 'socket hang up' })],
    ['timeout', new Anthropic.APIConnectionTimeoutError()],
    [
      'error event mid-stream',
      new Anthropic.APIError(undefined, body('overloaded_error'), undefined, headers),
    ],
  ])('maps %s to a transient LLM_UNAVAILABLE', (_name, err) => {
    const mapped = toJobError(err);
    expect(mapped).toBeInstanceOf(TransientError);
    expect((mapped as TransientError).code).toBe('LLM_UNAVAILABLE');
    expect((mapped as TransientError).cause).toBe(err);
  });

  it.each([
    ['401', new Anthropic.AuthenticationError(401, body('authentication_error'), 'x', headers)],
    ['403', new Anthropic.PermissionDeniedError(403, body('permission_error'), 'x', headers)],
    ['404 model', new Anthropic.NotFoundError(404, body('not_found_error'), 'x', headers)],
    ['402 billing', new Anthropic.APIError(402, body('billing_error'), 'x', headers)],
  ])('maps %s to a permanent LLM_NOT_CONFIGURED', (_name, err) => {
    const mapped = toJobError(err);
    expect(mapped).toBeInstanceOf(PermanentError);
    expect((mapped as PermanentError).code).toBe('LLM_NOT_CONFIGURED');
    // The user-facing text never carries the API's own message.
    expect((mapped as PermanentError).userMessage).not.toContain('details');
  });

  it('maps a rejected request (400) to a permanent INTERNAL error', () => {
    const err = new Anthropic.BadRequestError(400, body('invalid_request_error'), 'x', headers);
    const mapped = toJobError(err) as PermanentError;
    expect(mapped).toBeInstanceOf(PermanentError);
    expect(mapped.code).toBe('INTERNAL');
    expect(mapped.message).toContain('details'); // kept for the logs only
  });

  it('passes the abort reason through when our signal aborted the call', () => {
    const controller = new AbortController();
    const reason = new Error('lease lost');
    controller.abort(reason);
    expect(toJobError(new Anthropic.APIUserAbortError(), controller.signal)).toBe(reason);
  });

  it('leaves unknown errors alone', () => {
    const err = new TypeError('bug');
    expect(toJobError(err)).toBe(err);
  });
});
