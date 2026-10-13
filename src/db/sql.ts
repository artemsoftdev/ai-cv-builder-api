import type { EntityManager } from 'typeorm';

export interface SqlResult<Row> {
  rows: Row[];
  affected: number;
}

/** One result shape for every command (`manager.query()` returns different ones). */
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
