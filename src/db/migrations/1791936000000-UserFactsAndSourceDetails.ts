import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UserFactsAndSourceDetails1791936000000 implements MigrationInterface {
  name = 'UserFactsAndSourceDetails1791936000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE cvs
        ADD COLUMN user_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN source_transcribed boolean NOT NULL DEFAULT false,
        ADD CONSTRAINT cvs_user_facts_array_chk CHECK (jsonb_typeof(user_facts) = 'array')
    `);
    await queryRunner.query(`ALTER TABLE cv_questions ADD COLUMN error_message text`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE cv_questions DROP COLUMN error_message`);
    await queryRunner.query(`
      ALTER TABLE cvs
        DROP CONSTRAINT cvs_user_facts_array_chk,
        DROP COLUMN source_transcribed,
        DROP COLUMN user_facts
    `);
  }
}
