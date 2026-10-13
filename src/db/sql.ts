import type { EntityManager } from 'typeorm';

export interface SqlResult<Row> {
  rows: Row[];
  affected: number;
}

/**
 * Runs a raw statement and returns its rows and affected-row count in one shape, whatever the
 * command. (`manager.query()` returns `[rows, count]` for UPDATE/DELETE but plain rows for
 * SELECT/INSERT, which is easy to get wrong.) Uses the manager's transaction when it has one.
 */
export async function runSql<Row = Record<string, unknown>>(
  manager: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<SqlResult<Row>> {
  const ownRunner = manager.queryRunner === undefined;
  const queryRunner = manager.queryRunner ?? manager.connection.createQueryRunner();
  try {
    const result = await queryRunner.query(sql, params, true);
    return { rows: (result.records ?? []) as Row[], affected: result.affected ?? 0 };
  } finally {
    if (ownRunner) await queryRunner.release();
  }
}
