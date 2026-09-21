/** Typed API client. Sends the session cookie and the CSRF token, nothing else. */
export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
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
  if (init.body) headers.set('content-type', 'application/json');
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

export interface Me {
  user: { id: string; email: string; name: string; locale: 'ar' | 'en'; timezone: string };
  workspaces: Array<{ id: string; name: string; role: string }>;
  currentWorkspaceId: string | null;
  role: string | null;
  permissions: string[];
  csrfToken: string;
}

export interface Capabilities {
  phase: number;
  providers: Array<{ kind: string; providerId: string | null; configured: boolean; reason: string; plannedPhase: number }>;
  features: Record<string, string>;
}

export const api = {
  me: () => call<Me>('/api/v1/auth/me'),
  login: (email: string, password: string) =>
    call<{ csrfToken: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (input: { email: string; name: string; password: string; locale: 'ar' | 'en' }) =>
    call<{ csrfToken: string }>('/api/v1/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => call<void>('/api/v1/auth/logout', { method: 'POST' }),
  switchWorkspace: (workspaceId: string) =>
    call<{ workspaceId: string; role: string }>('/api/v1/auth/switch-workspace', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    }),
  setLocale: (locale: 'ar' | 'en') =>
    call<{ locale: 'ar' | 'en' }>('/api/v1/auth/preferences', {
      method: 'POST',
      body: JSON.stringify({ locale }),
    }),
  capabilities: () => call<Capabilities>('/api/v1/system/capabilities'),
  audit: (workspaceId: string) =>
    call<{ entries: Array<{ id: string; action: string; actorType: string; result: string; createdAt: string }> }>(
      `/api/v1/workspaces/${workspaceId}/audit?limit=8`,
    ),
  auditVerify: (workspaceId: string) =>
    call<{ ok: boolean; rowsChecked: number }>(`/api/v1/workspaces/${workspaceId}/audit/verify`),
};
