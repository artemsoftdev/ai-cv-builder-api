import Anthropic from '@anthropic-ai/sdk';
import { PermanentError, TransientError } from '../jobs/job-errors.js';

const KEY_REJECTED_MESSAGE =
  'AI generation is not configured correctly on the server (the API key was rejected).';

/** An abort caused by our own signal surfaces as the signal's reason. */
export function toJobError(err: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason ?? err;

  // Most specific classes first: several of these extend APIError.
  if (err instanceof Anthropic.RateLimitError) {
    return new TransientError(`Anthropic rate limit: ${err.message}`, 'LLM_UNAVAILABLE', {
      cause: err,
    });
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new TransientError(`Anthropic server error ${err.status}`, 'LLM_UNAVAILABLE', {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new TransientError(`Anthropic connection failed: ${err.message}`, 'LLM_UNAVAILABLE', {
      cause: err,
    });
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new PermanentError(
      'LLM_NOT_CONFIGURED',
      `Anthropic rejected the API key: ${err.message}`,
      {
        cause: err,
        userMessage: KEY_REJECTED_MESSAGE,
      },
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new PermanentError(
      'LLM_NOT_CONFIGURED',
      `Anthropic model not available: ${err.message}`,
      {
        cause: err,
        userMessage: 'The configured AI model is not available to this API key.',
      },
    );
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new PermanentError('INTERNAL', `Anthropic rejected the request: ${err.message}`, {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === undefined) {
      // An `error` event in the middle of a stream.
      return new TransientError(`Anthropic stream error: ${err.message}`, 'LLM_UNAVAILABLE', {
        cause: err,
      });
    }
    if (err.status === 402) {
      return new PermanentError('LLM_NOT_CONFIGURED', `Anthropic billing error: ${err.message}`, {
        cause: err,
        userMessage: 'The AI service account on the server cannot be used right now (billing).',
      });
    }
    if (err.status === 408 || err.status === 409) {
      return new TransientError(`Anthropic error ${err.status}`, 'LLM_UNAVAILABLE', { cause: err });
    }
    return new PermanentError('INTERNAL', `Anthropic error ${err.status ?? '?'}: ${err.message}`, {
      cause: err,
    });
  }
  return err;
}
