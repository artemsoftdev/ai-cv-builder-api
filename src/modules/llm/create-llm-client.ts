import type { AppConfig } from '../../config/config.js';
import type { Logger } from '../../logger.js';
import { AnthropicLlmClient } from './anthropic-llm-client.js';
import { FakeLlmClient } from './fake-llm-client.js';
import type { LlmClient } from './llm-client.js';

export function createLlmClient(config: AppConfig['llm'], logger: Logger): LlmClient {
  if (config.provider === 'fake') {
    logger.warn('LLM_PROVIDER=fake: CVs are drafted by heuristics, not by Claude');
    return new FakeLlmClient({ delayMs: config.fakeDelayMs });
  }
  if (!config.apiKey) {
    // Not fatal: the API stays usable (and health reports missing_key); generation jobs fail
    // with LLM_NOT_CONFIGURED until the key is set.
    logger.warn(
      'ANTHROPIC_API_KEY is not set: CV generation will fail with LLM_NOT_CONFIGURED. ' +
        'Set it in .env, or use LLM_PROVIDER=fake for a keyless demo.',
    );
  }
  return new AnthropicLlmClient(config, logger.child({ component: 'llm' }));
}
