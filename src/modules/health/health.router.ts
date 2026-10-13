import { Router } from 'express';
import type { DataSource } from 'typeorm';
import type { AppConfig } from '../../config/config.js';

const DB_CHECK_TIMEOUT_MS = 2_000;

export type LlmStatus = 'configured' | 'missing_key' | 'fake';

export function llmStatus(llm: AppConfig['llm']): LlmStatus {
  if (llm.provider === 'fake') return 'fake';
  return llm.apiKey ? 'configured' : 'missing_key';
}

async function isDatabaseUp(dataSource: DataSource): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DB health check timed out')), DB_CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([dataSource.query('SELECT 1'), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/health: public liveness/readiness probe (used by the compose healthcheck). */
export function createHealthRouter(deps: { dataSource: DataSource; config: AppConfig }): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    const dbUp = await isDatabaseUp(deps.dataSource);
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? 'ok' : 'degraded',
      db: dbUp ? 'ok' : 'down',
      llm: llmStatus(deps.config.llm),
    });
  });
  return router;
}
