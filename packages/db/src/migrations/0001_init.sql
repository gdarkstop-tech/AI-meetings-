-- 0001_init: foundation schema (Phase 1)
-- Every domain row is workspace-scoped. Scope enforcement lives in the
-- repository layer; these constraints make violations impossible to persist.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE workspaces (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (length(btrim(name)) > 0),
  locale_default text NOT NULL DEFAULT 'en' CHECK (locale_default IN ('ar','en')),
  timezone       text NOT NULL DEFAULT 'UTC',
  retention_days integer NOT NULL DEFAULT 365 CHECK (retention_days > 0),
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  locale        text NOT NULL DEFAULT 'en' CHECK (locale IN ('ar','en')),
  timezone      text NOT NULL DEFAULT 'UTC',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Email uniqueness is case-insensitive; the application also lowercases on input.
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only the SHA-256 of the session token is stored; the raw token lives in the
  -- client cookie and never in the database or in logs.
  token_hash    text NOT NULL UNIQUE,
  csrf_token    text NOT NULL,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- Append-only audit log with a per-workspace hash chain.
CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigserial NOT NULL,
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_type     text NOT NULL CHECK (actor_type IN ('user','ai','system')),
  actor_id       uuid,
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  payload_digest text,
  result         text NOT NULL CHECK (result IN ('success','failure','denied')),
  reason         text,
  ip             text,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  prev_hash      text,
  hash           text NOT NULL
);
CREATE INDEX audit_log_workspace_seq_idx ON audit_log (workspace_id, seq);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC);

-- Immutability is enforced by the database, not by convention.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  EXECUTE FUNCTION audit_log_is_append_only();

-- Database-backed job queue (drained by apps/worker). No Redis required.
CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','succeeded','failed','dead')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_by    text,
  locked_at    timestamptz,
  last_error   text,
  result       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_claim_idx ON jobs (status, run_after) WHERE status = 'queued';
CREATE INDEX jobs_workspace_idx ON jobs (workspace_id, created_at DESC);
