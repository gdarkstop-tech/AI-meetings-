import type { Queryable } from '../client.js';
import type { Scope } from '@alia/core';

export interface ConversationRow {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Array<Record<string, unknown>>;
  sufficient: boolean | null;
  created_at: Date;
}

export async function createConversation(db: Queryable, scope: Scope, title: string): Promise<ConversationRow> {
  const { rows } = await db.query<ConversationRow>(
    `INSERT INTO conversations (workspace_id, user_id, title) VALUES ($1,$2,$3) RETURNING *`,
    [scope.workspaceId, scope.userId, title.slice(0, 120)],
  );
  return rows[0];
}

export async function listConversations(db: Queryable, scope: Scope): Promise<ConversationRow[]> {
  const { rows } = await db.query<ConversationRow>(
    `SELECT * FROM conversations WHERE workspace_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 50`,
    [scope.workspaceId, scope.userId],
  );
  return rows;
}

export async function findConversation(
  db: Queryable,
  scope: Scope,
  id: string,
): Promise<ConversationRow | null> {
  const { rows } = await db.query<ConversationRow>(
    `SELECT * FROM conversations WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
    [id, scope.workspaceId, scope.userId],
  );
  return rows[0] ?? null;
}

export async function appendMessage(
  db: Queryable,
  input: {
    workspaceId: string;
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    citations?: unknown[];
    retrievedSegmentIds?: string[];
    sufficient?: boolean | null;
    providerId?: string | null;
    modelVersion?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  },
): Promise<ChatMessageRow> {
  const { rows } = await db.query<ChatMessageRow>(
    `INSERT INTO conversation_messages
       (workspace_id, conversation_id, role, content, citations, retrieved_segment_ids, sufficient,
        provider_id, model_version, input_tokens, output_tokens)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      input.workspaceId,
      input.conversationId,
      input.role,
      input.content,
      JSON.stringify(input.citations ?? []),
      input.retrievedSegmentIds ?? [],
      input.sufficient ?? null,
      input.providerId ?? null,
      input.modelVersion ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
    ],
  );
  await db.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [input.conversationId]);
  return rows[0];
}

export async function listMessages(db: Queryable, conversationId: string): Promise<ChatMessageRow[]> {
  const { rows } = await db.query<ChatMessageRow>(
    `SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 200`,
    [conversationId],
  );
  return rows;
}

// ------------------------------------------------------------------- memory
export interface MemoryRow {
  id: string;
  workspace_id: string;
  scope: 'workspace' | 'user' | 'project';
  type: string;
  key: string;
  value: Record<string, unknown>;
  source_type: string;
  source_id: string | null;
  created_by: 'user' | 'ai';
  status: 'active' | 'archived';
  created_at: Date;
}

export async function upsertMemory(
  db: Queryable,
  scope: Scope,
  input: {
    scope: 'workspace' | 'user' | 'project';
    scopeRefId?: string | null;
    type: string;
    key: string;
    value: Record<string, unknown>;
    sourceType: string;
    sourceId?: string | null;
    createdBy: 'user' | 'ai';
  },
): Promise<MemoryRow> {
  const { rows } = await db.query<MemoryRow>(
    `INSERT INTO memory_entries
       (workspace_id, scope, scope_ref_id, type, key, value, source_type, source_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      scope.workspaceId,
      input.scope,
      input.scopeRefId ?? null,
      input.type,
      input.key,
      input.value,
      input.sourceType,
      input.sourceId ?? null,
      input.createdBy,
    ],
  );
  return rows[0];
}

export async function listMemory(db: Queryable, scope: Scope): Promise<MemoryRow[]> {
  const { rows } = await db.query<MemoryRow>(
    `SELECT * FROM memory_entries
      WHERE workspace_id = $1 AND status = 'active'
        AND (scope <> 'user' OR scope_ref_id = $2)
      ORDER BY created_at DESC LIMIT 200`,
    [scope.workspaceId, scope.userId],
  );
  return rows;
}

/** Deletion is real: the row is removed, not hidden. */
export async function deleteMemory(db: Queryable, scope: Scope, id: string): Promise<boolean> {
  const res = await db.query(`DELETE FROM memory_entries WHERE id = $1 AND workspace_id = $2`, [
    id,
    scope.workspaceId,
  ]);
  return (res.rowCount ?? 0) > 0;
}
