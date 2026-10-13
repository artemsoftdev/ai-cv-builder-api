import type { EntityManager } from 'typeorm';
import { runSql } from '../../db/sql.js';
import { AppError } from '../../http/errors.js';

export const DEFAULT_MAX_ACTIVE_GENERATIONS = 3;
const RETRY_AFTER_SECONDS = '30';

/**
 * Enforces "at most N CVs generating per user" inside the transaction that starts a new
 * generation. Locking the user row serialises concurrent starts of the same user, so two
 * parallel uploads cannot both see N-1 and both proceed.
 */
export async function assertGenerationCapacity(
  manager: EntityManager,
  userId: string,
  maxActive: number,
): Promise<void> {
  await runSql(manager, 'SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const { rows } = await runSql<{ count: number }>(
    manager,
    `SELECT count(*)::int AS count FROM cvs WHERE user_id = $1 AND status = 'generating'`,
    [userId],
  );
  if ((rows[0]?.count ?? 0) >= maxActive) {
    throw new AppError(
      'RATE_LIMITED',
      `You can generate at most ${maxActive} CVs at the same time. Please wait for one to finish.`,
      undefined,
      { 'Retry-After': RETRY_AFTER_SECONDS },
    );
  }
}
