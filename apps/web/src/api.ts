/** Typed API client. Sends the session cookie and CSRF token, nothing else. */
export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

export class ApiRequestError extends Error {
  constructor(public readonly error: ApiError, public readonly status: number) {
    super(error.message);
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof Blob)) headers.set('content-type', 'application/json');
  if (csrfToken && init.method && init.method !== 'GET') headers.set('x-csrf-token', csrfToken);

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiRequestError(
      (payload as { error?: ApiError }).error ?? { code: 'INTERNAL', message: 'Request failed' },
      res.status,
    );
  }
  return payload as T;
}

const json = (method: string, body?: unknown) => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export interface Me {
  user: { id: string; email: string; name: string; locale: 'ar' | 'en'; timezone: string };
  workspaces: Array<{ id: string; name: string; role: string }>;
  currentWorkspaceId: string | null;
  role: string | null;
  permissions: string[];
  csrfToken: string;
}

export interface Capabilities {
  providers: Array<{ kind: string; providerId: string | null; configured: boolean; reason: string; requires: string[] }>;
  features: Record<string, string>;
}

export interface Meeting {
  id: string;
  title: string;
  language: 'ar' | 'en' | 'mixed';
  status: 'draft' | 'recording' | 'uploaded' | 'processing' | 'ready' | 'failed';
  failure_reason: string | null;
  consent_obtained: boolean;
  consent_method: string | null;
  duration_ms: string | null;
  created_at: string;
  started_at: string | null;
  retention_expires_at: string | null;
  notes: string | null;
}

export interface Segment {
  id: string;
  idx: number;
  startMs: number;
  endMs: number;
  speaker: string;
  speakerLabel: string;
  text: string;
  confidence: number | null;
}

export interface Decision {
  id: string;
  text: string;
  owner_hint: string | null;
  start_ms: number;
  status: string;
  confidence: string;
  evidence_segment_ids: string[];
}

export interface ActionItem {
  id: string;
  title: string;
  description: string | null;
  assignee_hint: string | null;
  due_at: string | null;
  due_source_text: string | null;
  priority: string;
  start_ms: number;
  status: string;
  task_id: string | null;
}

export interface Task {
  id: string;
  title: string;
  status: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
  priority: string;
  due_at: string | null;
  source_meeting_id: string | null;
  source_type: string;
}

export interface SearchHit {
  type: string;
  id: string;
  meetingId: string | null;
  meetingTitle: string | null;
  title: string;
  snippet: string;
  startMs: number | null;
  occurredAt: string | null;
  matchedBy: string[];
}

export interface ActionRow {
  id: string;
  type: string;
  summary: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  status: string;
  requiresApproval: boolean;
  requestedVia: string;
  policyReason: string | null;
  dryRun: boolean;
  providerResponseId: string | null;
  error: string | null;
  createdAt: string;
  executedAt: string | null;
}

export const api = {
  me: () => call<Me>('/api/v1/auth/me'),
  login: (email: string, password: string) => call<{ csrfToken: string }>('/api/v1/auth/login', json('POST', { email, password })),
  register: (input: { email: string; name: string; password: string; locale: 'ar' | 'en' }) =>
    call<{ csrfToken: string }>('/api/v1/auth/register', json('POST', input)),
  logout: () => call<void>('/api/v1/auth/logout', json('POST')),
  switchWorkspace: (workspaceId: string) => call<{ workspaceId: string }>('/api/v1/auth/switch-workspace', json('POST', { workspaceId })),
  setLocale: (locale: 'ar' | 'en') => call<{ locale: 'ar' | 'en' }>('/api/v1/auth/preferences', json('POST', { locale })),
  capabilities: () => call<Capabilities>('/api/v1/system/capabilities'),

  meetings: () => call<{ meetings: Meeting[] }>('/api/v1/meetings'),
  meeting: (id: string) =>
    call<{
      meeting: Meeting;
      media: Array<{ kind: string; mimeType: string; bytes: number; durationMs: number | null }>;
      speakers: Array<{ speaker_label: string; person_id: string; display_name: string }>;
      chapters: Array<{ id: string; title: string; start_ms: number; end_ms: number }>;
    }>(`/api/v1/meetings/${id}`),
  createMeeting: (input: {
    title: string;
    language: 'ar' | 'en' | 'mixed';
    source?: 'upload' | 'live_recording';
    consent: { obtained: boolean; method?: string; note?: string };
  }) => call<{ meeting: Meeting }>('/api/v1/meetings', json('POST', input)),
  recordConsent: (id: string, method: string, note?: string) =>
    call<{ meeting: Meeting }>(`/api/v1/meetings/${id}/consent`, json('POST', { method, note })),
  deleteMeeting: (id: string) => call<{ deleted: boolean }>(`/api/v1/meetings/${id}`, json('DELETE')),
  reprocess: (id: string, stage: 'transcribe' | 'analyze') =>
    call<{ queued: string }>(`/api/v1/meetings/${id}/reprocess`, json('POST', { stage })),

  initUpload: (meetingId: string, input: { filename: string; mimeType: string; totalBytes: number }) =>
    call<{ uploadId: string; chunkSize: number; chunkCount: number; receivedChunks: number[] }>(
      `/api/v1/meetings/${meetingId}/uploads`,
      json('POST', input),
    ),
  uploadStatus: (meetingId: string, uploadId: string) =>
    call<{ receivedChunks: number[]; chunkSize: number; status: string }>(
      `/api/v1/meetings/${meetingId}/uploads/${uploadId}`,
    ),
  putChunk: async (meetingId: string, uploadId: string, index: number, blob: Blob) => {
    const headers = new Headers({ 'content-type': 'application/octet-stream' });
    if (csrfToken) headers.set('x-csrf-token', csrfToken);
    const res = await fetch(`/api/v1/meetings/${meetingId}/uploads/${uploadId}/chunks/${index}`, {
      method: 'PUT',
      headers,
      body: blob,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new ApiRequestError((payload as { error?: ApiError }).error ?? { code: 'INTERNAL', message: 'Chunk failed' }, res.status);
    }
  },
  completeUpload: (meetingId: string, uploadId: string) =>
    call<{ media: { bytes: number; checksum: string } }>(
      `/api/v1/meetings/${meetingId}/uploads/${uploadId}/complete`,
      json('POST', {}),
    ),

  transcript: (meetingId: string) => call<{ segments: Segment[]; status: string }>(`/api/v1/meetings/${meetingId}/transcript`),
  insights: (meetingId: string) =>
    call<{
      summaries: Array<{ kind: string; content: Record<string, unknown>; model: string; promptVersion: string; generatedAt: string }>;
      decisions: Decision[];
      actionItems: ActionItem[];
      chapters: Array<{ id: string; title: string; start_ms: number }>;
    }>(`/api/v1/meetings/${meetingId}/insights`),
  speakers: (meetingId: string) =>
    call<{ labels: string[]; mapped: Array<{ speaker_label: string; display_name: string }>; people: Array<{ id: string; display_name: string }> }>(
      `/api/v1/meetings/${meetingId}/speakers`,
    ),
  assignSpeaker: (meetingId: string, speakerLabel: string, displayName: string) =>
    call<{ personId: string; segmentsUpdated: number }>(
      `/api/v1/meetings/${meetingId}/speakers`,
      json('POST', { speakerLabel, displayName }),
    ),
  reviewDecision: (id: string, status: 'accepted' | 'rejected') =>
    call<{ decision: Decision }>(`/api/v1/decisions/${id}/review`, json('POST', { status })),
  acceptActionItem: (id: string) => call<{ task: Task }>(`/api/v1/action-items/${id}/accept`, json('POST', {})),
  rejectActionItem: (id: string) => call<{ actionItem: ActionItem }>(`/api/v1/action-items/${id}/reject`, json('POST', {})),

  tasks: (view?: string) => call<{ tasks: Task[]; counts: Record<string, number> }>(`/api/v1/tasks${view ? `?view=${view}` : ''}`),
  createTask: (input: { title: string; dueAt?: string; priority?: string }) => call<{ task: Task }>('/api/v1/tasks', json('POST', input)),
  updateTask: (id: string, patch: Record<string, unknown>) => call<{ task: Task }>(`/api/v1/tasks/${id}`, json('PATCH', patch)),

  search: (query: string) =>
    call<{ hits: SearchHit[]; semanticAvailable: boolean; degradedReason: string | null }>(
      `/api/v1/search?q=${encodeURIComponent(query)}`,
    ),
  ask: (question: string, conversationId?: string) =>
    call<{
      conversationId: string;
      answer: string;
      sufficient: boolean;
      citations: Array<{ segmentId: string; meetingId: string; meetingTitle: string; speaker: string; startMs: number; quote: string }>;
      model: string;
    }>('/api/v1/ask', json('POST', { question, conversationId })),

  actions: (status?: string) => call<{ actions: ActionRow[] }>(`/api/v1/actions${status ? `?status=${status}` : ''}`),
  approveAction: (id: string, payloadDigest: string) =>
    call<{ execution: string }>(`/api/v1/actions/${id}/approve`, json('POST', { payloadDigest })),
  rejectAction: (id: string, reason: string) => call<{ action: ActionRow }>(`/api/v1/actions/${id}/reject`, json('POST', { reason })),
  followUp: (meetingId: string, to: string[]) =>
    call<{ draft: { email: { subject: string; body: string } }; proposedAction: { id: string } | null; reason?: string }>(
      `/api/v1/meetings/${meetingId}/followup`,
      json('POST', { to }),
    ),

  settings: () =>
    call<{
      settings: {
        name: string;
        timezone: string;
        retention_days: number;
        media_retention_days: number | null;
        require_recording_consent: boolean;
        ai_enabled: boolean;
        external_actions_enabled: boolean;
        monthly_audio_minutes_quota: number;
      };
    }>('/api/v1/workspace/settings'),
  updateSettings: (patch: Record<string, unknown>) => call<{ settings: unknown }>('/api/v1/workspace/settings', json('PATCH', patch)),
  costs: () =>
    call<{ days: number; totalCostUsd: number; providers: Array<{ kind: string; provider: string; calls: number; failures: number; audioMinutes: number; costUsd: number }> }>(
      '/api/v1/workspace/costs',
    ),
  integrations: () =>
    call<{ integrations: Array<{ kind: string; status: string; scopes: string[]; external_account_email: string | null }>; providers: Capabilities['providers'] }>(
      '/api/v1/integrations',
    ),
  authorizeIntegration: (kind: 'google' | 'microsoft', capabilities: string[]) =>
    call<{ authorizeUrl: string }>(`/api/v1/integrations/${kind}/authorize`, json('POST', { capabilities })),
  disconnectIntegration: (kind: string) => call<{ disconnected: string }>(`/api/v1/integrations/${kind}`, json('DELETE')),
  memory: () => call<{ entries: Array<{ id: string; type: string; key: string; value: Record<string, unknown>; source: { type: string }; createdBy: string }> }>('/api/v1/workspace/memory'),
  deleteMemory: (id: string) => call<{ deleted: boolean }>(`/api/v1/workspace/memory/${id}`, json('DELETE')),
  deletions: () => call<{ deletions: Array<{ target_type: string; target_id: string; reason: string; artifacts: Record<string, number>; completed_at: string }> }>('/api/v1/workspace/deletions'),
  jobs: () => call<{ counts: Record<string, number> }>('/api/v1/workspace/jobs'),
  audit: (workspaceId: string) =>
    call<{ entries: Array<{ id: string; action: string; actorType: string; result: string; createdAt: string }> }>(
      `/api/v1/workspaces/${workspaceId}/audit?limit=12`,
    ),
};
