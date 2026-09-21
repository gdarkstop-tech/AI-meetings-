import { z } from 'zod';

/**
 * OAuth 2.0 authorization-code flow for Google and Microsoft.
 *
 * Scopes are requested incrementally and per feature (read before write, send
 * only when the workspace enables sending). Tokens returned here are encrypted
 * by the caller before storage and never logged.
 */
export type OAuthKind = 'google' | 'microsoft';

export const GOOGLE_SCOPES = {
  calendarRead: 'https://www.googleapis.com/auth/calendar.readonly',
  calendarWrite: 'https://www.googleapis.com/auth/calendar.events',
  mailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  mailSend: 'https://www.googleapis.com/auth/gmail.send',
  profile: 'https://www.googleapis.com/auth/userinfo.email',
} as const;

export const MICROSOFT_SCOPES = {
  calendarRead: 'Calendars.Read',
  calendarWrite: 'Calendars.ReadWrite',
  mailRead: 'Mail.Read',
  mailSend: 'Mail.Send',
  profile: 'User.Read',
  offline: 'offline_access',
} as const;

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenant?: string;
}

const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  id_token: z.string().optional(),
});

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date | null;
  scopes: string[];
}

function authorizeEndpoint(kind: OAuthKind, tenant: string): string {
  return kind === 'google'
    ? 'https://accounts.google.com/o/oauth2/v2/auth'
    : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

function tokenEndpoint(kind: OAuthKind, tenant: string): string {
  return kind === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export function buildAuthorizeUrl(input: {
  kind: OAuthKind;
  config: OAuthClientConfig;
  scopes: string[];
  state: string;
}): string {
  const tenant = input.config.tenant ?? 'common';
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    redirect_uri: input.config.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    state: input.state,
  });
  if (input.kind === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    params.set('include_granted_scopes', 'true');
  } else {
    params.set('response_mode', 'query');
  }
  return `${authorizeEndpoint(input.kind, tenant)}?${params.toString()}`;
}

async function postToken(url: string, body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OAuth token request failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const parsed = tokenSchema.parse(await res.json());
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_in ? new Date(Date.now() + parsed.expires_in * 1000) : null,
    scopes: parsed.scope ? parsed.scope.split(' ') : [],
  };
}

export async function exchangeCode(input: {
  kind: OAuthKind;
  config: OAuthClientConfig;
  code: string;
}): Promise<TokenSet> {
  const tenant = input.config.tenant ?? 'common';
  return postToken(
    tokenEndpoint(input.kind, tenant),
    new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      redirect_uri: input.config.redirectUri,
      grant_type: 'authorization_code',
      code: input.code,
    }),
  );
}

export async function refreshAccessToken(input: {
  kind: OAuthKind;
  config: OAuthClientConfig;
  refreshToken: string;
}): Promise<TokenSet> {
  const tenant = input.config.tenant ?? 'common';
  const tokens = await postToken(
    tokenEndpoint(input.kind, tenant),
    new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    }),
  );
  // Google omits the refresh token on refresh; keep the original.
  return { ...tokens, refreshToken: tokens.refreshToken ?? input.refreshToken };
}

/** Identify the connected mailbox so the UI can show which account is linked. */
export async function fetchAccountEmail(kind: OAuthKind, accessToken: string): Promise<string | null> {
  const url =
    kind === 'google'
      ? 'https://www.googleapis.com/oauth2/v2/userinfo'
      : 'https://graph.microsoft.com/v1.0/me';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const body = (await res.json()) as { email?: string; mail?: string; userPrincipalName?: string };
  return body.email ?? body.mail ?? body.userPrincipalName ?? null;
}
