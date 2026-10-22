-- CI-only metadata fixture for the two agenda outbox migrations.
-- This is not a functional migration or a replacement for Supabase CLI history.
CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[],
  name text,
  created_by text,
  idempotency_key text,
  rollback text
);
