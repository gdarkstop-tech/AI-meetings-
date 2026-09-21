-- 0003_product_domain: the real product data model.
-- Meetings, media, transcripts, speakers, AI artifacts, tasks, search,
-- consent/retention, action gateway, integrations, memory, research and chat.
-- Written once, as the production model (docs/02-data-model.md) rather than a
-- throwaway shape.

-- ---------------------------------------------------------------- workspace
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS media_retention_days integer,
  ADD COLUMN IF NOT EXISTS require_recording_consent boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS external_actions_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS monthly_audio_minutes_quota integer NOT NULL DEFAULT 6000;

-- ----------------------------------------------------------------- projects
CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  client_name  text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX projects_workspace_idx ON projects (workspace_id) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------------- people
CREATE TABLE people (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  name_normalized text NOT NULL DEFAULT '',
  email        text,
  aliases      text[] NOT NULL DEFAULT '{}',
  notes        text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX people_workspace_idx ON people (workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX people_name_trgm_idx ON people USING gin (name_normalized gin_trgm_ops);

-- ----------------------------------------------------------------- meetings
CREATE TABLE meetings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id     uuid REFERENCES projects(id) ON DELETE SET NULL,
  title          text NOT NULL CHECK (length(btrim(title)) > 0),
  title_normalized text NOT NULL DEFAULT '',
  description    text,
  notes          text,
  language       text NOT NULL DEFAULT 'mixed' CHECK (language IN ('ar','en','mixed')),
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','recording','uploaded','processing','ready','failed')),
  failure_reason text,
  failure_code   text,
  source         text NOT NULL DEFAULT 'upload' CHECK (source IN ('live_recording','upload','integration')),
  scheduled_at   timestamptz,
  started_at     timestamptz,
  ended_at       timestamptz,
  duration_ms    bigint,
  -- Consent and retention are first-class columns, not policy documents.
  consent_obtained      boolean NOT NULL DEFAULT false,
  consent_method        text CHECK (consent_method IN ('verbal','written','implied_policy','not_required')),
  consent_note          text,
  consent_recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  consent_recorded_at   timestamptz,
  retention_expires_at  timestamptz,
  media_purged_at       timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  -- A recording may only exist when consent was captured or explicitly waived.
  CONSTRAINT meetings_consent_shape CHECK (
    consent_obtained = false OR (consent_method IS NOT NULL AND consent_recorded_at IS NOT NULL)
  )
);
CREATE INDEX meetings_workspace_idx ON meetings (workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX meetings_status_idx ON meetings (workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX meetings_retention_idx ON meetings (retention_expires_at) WHERE deleted_at IS NULL AND media_purged_at IS NULL;
CREATE INDEX meetings_title_trgm_idx ON meetings USING gin (title_normalized gin_trgm_ops);

CREATE TABLE meeting_media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id    uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('original','normalized')),
  storage_key   text NOT NULL,
  mime_type     text NOT NULL,
  bytes         bigint NOT NULL CHECK (bytes >= 0),
  duration_ms   bigint,
  checksum_sha256 text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  purged_at     timestamptz
);
CREATE INDEX meeting_media_meeting_idx ON meeting_media (meeting_id, kind);

CREATE TABLE meeting_attendees (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  person_id    uuid REFERENCES people(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  email        text,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','calendar','diarization')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_attendees_meeting_idx ON meeting_attendees (meeting_id);

-- Resumable uploads: a server-owned session with fixed-size chunks.
CREATE TABLE upload_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  mime_type      text NOT NULL,
  total_bytes    bigint NOT NULL CHECK (total_bytes > 0),
  chunk_size     integer NOT NULL CHECK (chunk_size > 0),
  received_chunks integer[] NOT NULL DEFAULT '{}',
  received_bytes bigint NOT NULL DEFAULT 0,
  storage_prefix text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','aborted')),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX upload_sessions_meeting_idx ON upload_sessions (meeting_id, status);

-- --------------------------------------------------------------- transcripts
CREATE TABLE transcript_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id    uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  provider_id   text NOT NULL,
  model_version text NOT NULL,
  language_hint text NOT NULL,
  is_current    boolean NOT NULL DEFAULT true,
  segment_count integer NOT NULL DEFAULT 0,
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcript_versions_meeting_idx ON transcript_versions (meeting_id, created_at DESC);

CREATE TABLE transcript_segments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  version_id     uuid NOT NULL REFERENCES transcript_versions(id) ON DELETE CASCADE,
  idx            integer NOT NULL,
  start_ms       integer NOT NULL CHECK (start_ms >= 0),
  end_ms         integer NOT NULL CHECK (end_ms >= 0),
  speaker_label  text NOT NULL,
  person_id      uuid REFERENCES people(id) ON DELETE SET NULL,
  text           text NOT NULL,
  -- Arabic/English normalized copy used for search only; display uses `text`.
  text_normalized text NOT NULL DEFAULT '',
  language       text,
  confidence     real,
  embedding      vector(1536),
  created_at     timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(text_normalized, ''))) STORED,
  UNIQUE (version_id, idx)
);
CREATE INDEX transcript_segments_meeting_idx ON transcript_segments (meeting_id, start_ms);
CREATE INDEX transcript_segments_tsv_idx ON transcript_segments USING gin (tsv);
CREATE INDEX transcript_segments_trgm_idx ON transcript_segments USING gin (text_normalized gin_trgm_ops);
CREATE INDEX transcript_segments_embedding_idx ON transcript_segments
  USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

CREATE TABLE speaker_map (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id    uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_label text NOT NULL,
  person_id     uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  confirmed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, speaker_label)
);

-- -------------------------------------------------------------- AI artifacts
CREATE TABLE summaries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('tldr','executive','detailed')),
  content        jsonb NOT NULL,
  output_language text NOT NULL DEFAULT 'en',
  provider_id    text NOT NULL,
  model_version  text NOT NULL,
  prompt_version text NOT NULL,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  superseded_by  uuid REFERENCES summaries(id) ON DELETE SET NULL
);
CREATE INDEX summaries_meeting_idx ON summaries (meeting_id, kind) WHERE superseded_by IS NULL;

CREATE TABLE decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text           text NOT NULL,
  text_normalized text NOT NULL DEFAULT '',
  owner_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  owner_hint     text,
  decided_on     date,
  context        text,
  -- Evidence is mandatory: an extraction with no transcript support is dropped
  -- by the validator and can never reach this table.
  evidence_segment_ids uuid[] NOT NULL CHECK (cardinality(evidence_segment_ids) > 0),
  start_ms       integer NOT NULL,
  confidence     text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  status         text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','accepted','rejected','edited')),
  provider_id    text,
  model_version  text,
  prompt_version text,
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(text_normalized, ''))) STORED
);
CREATE INDEX decisions_meeting_idx ON decisions (meeting_id, status);
CREATE INDEX decisions_workspace_idx ON decisions (workspace_id, created_at DESC);
CREATE INDEX decisions_tsv_idx ON decisions USING gin (tsv);

CREATE TABLE action_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  title          text NOT NULL,
  title_normalized text NOT NULL DEFAULT '',
  description    text,
  assignee_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  assignee_hint  text,
  due_at         timestamptz,
  due_source_text text,
  priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  evidence_segment_ids uuid[] NOT NULL CHECK (cardinality(evidence_segment_ids) > 0),
  start_ms       integer NOT NULL,
  confidence     text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  status         text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','accepted','rejected')),
  task_id        uuid,
  provider_id    text,
  model_version  text,
  prompt_version text,
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(title_normalized, ''))) STORED
);
CREATE INDEX action_items_meeting_idx ON action_items (meeting_id, status);
CREATE INDEX action_items_tsv_idx ON action_items USING gin (tsv);

CREATE TABLE chapters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  title        text NOT NULL,
  start_ms     integer NOT NULL,
  end_ms       integer NOT NULL,
  evidence_segment_ids uuid[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chapters_meeting_idx ON chapters (meeting_id, start_ms);

-- -------------------------------------------------------------------- tasks
CREATE TABLE tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (length(btrim(title)) > 0),
  title_normalized text NOT NULL DEFAULT '',
  description    text,
  assignee_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  assignee_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  project_id     uuid REFERENCES projects(id) ON DELETE SET NULL,
  due_at         timestamptz,
  priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status         text NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','IN_PROGRESS','DONE','CANCELLED')),
  source_type    text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','meeting','email','ai')),
  source_meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL,
  source_segment_id uuid REFERENCES transcript_segments(id) ON DELETE SET NULL,
  source_action_item_id uuid REFERENCES action_items(id) ON DELETE SET NULL,
  completed_at   timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(title_normalized, ''))) STORED
);
CREATE INDEX tasks_workspace_idx ON tasks (workspace_id, status, due_at) WHERE deleted_at IS NULL;
CREATE INDEX tasks_assignee_idx ON tasks (assignee_user_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_tsv_idx ON tasks USING gin (tsv);
ALTER TABLE action_items
  ADD CONSTRAINT action_items_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

-- ------------------------------------------------------- provider telemetry
CREATE TABLE provider_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id        uuid REFERENCES jobs(id) ON DELETE SET NULL,
  meeting_id    uuid REFERENCES meetings(id) ON DELETE SET NULL,
  provider_kind text NOT NULL,
  provider_id   text NOT NULL,
  model_version text,
  operation     text NOT NULL,
  latency_ms    integer,
  input_tokens  integer,
  output_tokens integer,
  audio_seconds real,
  cost_usd      numeric(12,6),
  outcome       text NOT NULL CHECK (outcome IN ('success','failure')),
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_calls_workspace_idx ON provider_calls (workspace_id, created_at DESC);

-- ------------------------------------------------------------ action gateway
CREATE TABLE actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  payload_digest  text NOT NULL,
  summary         text NOT NULL,
  requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_via   text NOT NULL CHECK (requested_via IN ('ui','ai')),
  source_meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed','approved','rejected','executing','executed','failed')),
  policy_reason   text,
  requires_approval boolean NOT NULL DEFAULT true,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  rejected_reason text,
  idempotency_key text NOT NULL UNIQUE,
  provider_id     text,
  provider_response_id text,
  dry_run         boolean NOT NULL DEFAULT false,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  executed_at     timestamptz
);
CREATE INDEX actions_workspace_idx ON actions (workspace_id, status, created_at DESC);

-- ------------------------------------------------------------- integrations
CREATE TABLE integrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('google','microsoft')),
  scopes          text[] NOT NULL DEFAULT '{}',
  external_account_email text,
  status          text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','expired','revoked','error')),
  -- Tokens are encrypted with AES-256-GCM before they reach this column and are
  -- never returned by any API response or written to a log.
  token_ciphertext text NOT NULL,
  token_expires_at timestamptz,
  last_error      text,
  last_refreshed_at timestamptz,
  connected_at    timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id, kind)
);

CREATE TABLE oauth_states (
  state         text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  code_verifier text,
  redirect_to   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

-- -------------------------------------------------------------- AI memory
CREATE TABLE memory_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('workspace','user','project')),
  scope_ref_id  uuid,
  type          text NOT NULL CHECK (type IN ('preference','fact','project','person','topic')),
  key           text NOT NULL,
  value         jsonb NOT NULL,
  source_type   text NOT NULL CHECK (source_type IN ('user','meeting','decision','task')),
  source_id     uuid,
  confidence    text NOT NULL DEFAULT 'medium',
  created_by    text NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','ai')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX memory_workspace_idx ON memory_entries (workspace_id, status);

-- --------------------------------------------------------------- research
CREATE TABLE research_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  question        text NOT NULL,
  origin_meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL,
  origin_segment_id uuid REFERENCES transcript_segments(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  failure_reason  text,
  requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE TABLE research_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id    uuid NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
  url           text NOT NULL,
  title         text,
  publisher     text,
  snippet       text,
  content_hash  text,
  retrieved_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE research_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id    uuid NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
  findings      jsonb NOT NULL,
  report_md     text NOT NULL,
  provider_id   text NOT NULL,
  model_version text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- Ask AI chat
CREATE TABLE conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL DEFAULT 'New conversation',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations (workspace_id, user_id, updated_at DESC);

CREATE TABLE conversation_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  content         text NOT NULL,
  citations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieved_segment_ids uuid[] NOT NULL DEFAULT '{}',
  sufficient      boolean,
  provider_id     text,
  model_version   text,
  input_tokens    integer,
  output_tokens   integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_messages_idx ON conversation_messages (conversation_id, created_at);

-- --------------------------------------------------------- data lifecycle
CREATE TABLE data_exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  scope        text NOT NULL CHECK (scope IN ('workspace','user','meeting')),
  scope_ref_id uuid,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  storage_key  text,
  bytes        bigint,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Records every irreversible erasure so deletion itself stays auditable.
CREATE TABLE deletion_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type   text NOT NULL,
  target_id     uuid NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('user_request','retention_policy','workspace_deletion')),
  requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  artifacts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deletion_records_workspace_idx ON deletion_records (workspace_id, completed_at DESC);
