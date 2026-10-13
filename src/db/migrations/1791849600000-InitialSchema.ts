import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1791849600000 implements MigrationInterface {
  name = 'InitialSchema1791849600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text        NOT NULL,
        password_hash text        NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_email_key UNIQUE (email),
        -- Uniqueness must be case-insensitive: the app stores emails trimmed + lowercased.
        CONSTRAINT users_email_normalized_chk CHECK (email = lower(btrim(email)))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE sessions (
        id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash text        NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)
      )
    `);
    await queryRunner.query(`CREATE INDEX sessions_user_id_idx ON sessions (user_id)`);

    await queryRunner.query(`
      CREATE TABLE cvs (
        id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        title           text        NOT NULL,
        target_role     text        NOT NULL,
        source_type     text        NOT NULL,
        source_filename text,
        source_text     text,
        source_pdf      bytea,
        status          text        NOT NULL DEFAULT 'generating',
        stage           text        NOT NULL DEFAULT 'queued',
        error_code      text,
        error_message   text,
        content         jsonb,
        review          jsonb,
        version         integer     NOT NULL DEFAULT 1,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cvs_source_type_chk CHECK (source_type IN ('pdf', 'text')),
        CONSTRAINT cvs_status_chk CHECK (status IN ('generating', 'ready', 'failed')),
        CONSTRAINT cvs_stage_chk
          CHECK (stage IN ('queued', 'extracting', 'drafting', 'verifying', 'done')),
        CONSTRAINT cvs_source_present_chk CHECK (source_text IS NOT NULL OR source_pdf IS NOT NULL),
        CONSTRAINT cvs_ready_has_content_chk CHECK (status <> 'ready' OR content IS NOT NULL),
        CONSTRAINT cvs_failed_has_error_chk CHECK (status <> 'failed' OR error_code IS NOT NULL),
        CONSTRAINT cvs_version_chk CHECK (version >= 1)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX cvs_user_id_created_at_idx ON cvs (user_id, created_at DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE cv_questions (
        id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        cv_id      uuid        NOT NULL REFERENCES cvs (id) ON DELETE CASCADE,
        section    text        NOT NULL,
        item_id    text,
        question   text        NOT NULL,
        answer     text,
        status     text        NOT NULL DEFAULT 'open',
        error      text,
        position   integer     NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cv_questions_section_chk
          CHECK (section IN ('contact', 'summary', 'experience', 'education', 'skills')),
        CONSTRAINT cv_questions_status_chk
          CHECK (status IN ('open', 'applying', 'applied', 'dismissed', 'failed'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX cv_questions_cv_id_position_idx ON cv_questions (cv_id, position)`,
    );

    await queryRunner.query(`
      CREATE TABLE jobs (
        id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        type         text        NOT NULL,
        cv_id        uuid        NOT NULL REFERENCES cvs (id) ON DELETE CASCADE,
        question_id  uuid        REFERENCES cv_questions (id) ON DELETE CASCADE,
        status       text        NOT NULL DEFAULT 'queued',
        attempts     integer     NOT NULL DEFAULT 0,
        max_attempts integer     NOT NULL DEFAULT 3,
        run_at       timestamptz NOT NULL DEFAULT now(),
        locked_by    text,
        locked_until timestamptz,
        last_error   text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        finished_at  timestamptz,
        CONSTRAINT jobs_type_chk CHECK (type IN ('generate_cv', 'apply_answer')),
        CONSTRAINT jobs_status_chk CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        CONSTRAINT jobs_question_matches_type_chk
          CHECK ((type = 'apply_answer') = (question_id IS NOT NULL)),
        CONSTRAINT jobs_attempts_chk CHECK (attempts >= 0 AND max_attempts >= 1)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX jobs_runnable_run_at_idx ON jobs (run_at) WHERE status IN ('queued', 'running')`,
    );
    await queryRunner.query(`CREATE INDEX jobs_cv_id_idx ON jobs (cv_id)`);
    await queryRunner.query(
      `CREATE INDEX jobs_question_id_idx ON jobs (question_id) WHERE question_id IS NOT NULL`,
    );
    // Makes "busy" race-free: a second concurrent enqueue fails (409 CV_BUSY).
    await queryRunner.query(
      `CREATE UNIQUE INDEX jobs_one_active_per_cv_uidx ON jobs (cv_id)
         WHERE status IN ('queued', 'running')`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE jobs`);
    await queryRunner.query(`DROP TABLE cv_questions`);
    await queryRunner.query(`DROP TABLE cvs`);
    await queryRunner.query(`DROP TABLE sessions`);
    await queryRunner.query(`DROP TABLE users`);
  }
}
