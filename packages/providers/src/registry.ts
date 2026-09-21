import { ProviderNotConfiguredError } from '@alia/core';
import { LocalStorageProvider } from './storage/local.js';
import { S3StorageProvider } from './storage/s3.js';
import { DeepgramTranscriptionProvider } from './asr/deepgram.js';
import { ElevenLabsTranscriptionProvider } from './asr/elevenlabs.js';
import { OpenAiTranscriptionProvider } from './asr/openai.js';
import { AnthropicLLMProvider } from './llm/anthropic.js';
import { OpenAiEmbeddingsProvider } from './embeddings/openai.js';
import { GoogleCalendarProvider } from './calendar/google.js';
import { MicrosoftCalendarProvider } from './calendar/microsoft.js';
import { GmailProvider } from './email/gmail.js';
import { MicrosoftEmailProvider } from './email/microsoft.js';
import { TavilySearchProvider } from './search/tavily.js';
import type { OAuthClientConfig, OAuthKind } from './oauth/index.js';
import type {
  CalendarProvider,
  EmailProvider,
  EmbeddingsProvider,
  LLMProvider,
  ProviderKind,
  ProviderStatus,
  StorageProvider,
  TranscriptionProvider,
  WebSearchProvider,
} from './types.js';

export type Env = Record<string, string | undefined>;

const value = (env: Env, key: string): string | undefined => {
  const raw = env[key];
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
};

/**
 * Wires real adapters from configuration.
 *
 * Contract (ADR 0005): a provider is either genuinely configured and returns a
 * working adapter, or it throws ProviderNotConfiguredError. There is no stub,
 * no sample data and no silent fallback anywhere in this file.
 */
export interface ProviderRegistry {
  statuses(): ProviderStatus[];
  isConfigured(kind: ProviderKind): boolean;
  storage(): StorageProvider;
  asr(): TranscriptionProvider;
  llm(): LLMProvider;
  embeddings(): EmbeddingsProvider;
  calendar(kind: 'google' | 'microsoft'): CalendarProvider;
  email(kind: 'gmail' | 'microsoft'): EmailProvider;
  webSearch(): WebSearchProvider;
  oauthConfig(kind: OAuthKind): OAuthClientConfig;
}

interface Resolution<T> {
  providerId: string | null;
  requires: string[];
  reason: string;
  build: (() => T) | null;
}

function resolveStorage(env: Env): Resolution<StorageProvider> {
  const selected = value(env, 'STORAGE_PROVIDER');
  if (!selected) {
    return {
      providerId: null,
      requires: ['STORAGE_PROVIDER'],
      reason: 'No storage provider selected (STORAGE_PROVIDER=local|s3).',
      build: null,
    };
  }
  if (selected === 'local') {
    const dir = value(env, 'STORAGE_LOCAL_DIR');
    if (!dir) {
      return {
        providerId: 'local',
        requires: ['STORAGE_LOCAL_DIR'],
        reason: 'Local storage selected but STORAGE_LOCAL_DIR is not set.',
        build: null,
      };
    }
    return { providerId: 'local', requires: [], reason: 'Local filesystem storage.', build: () => new LocalStorageProvider(dir) };
  }
  if (selected === 's3') {
    const bucket = value(env, 'S3_BUCKET');
    const region = value(env, 'S3_REGION');
    const accessKeyId = value(env, 'S3_ACCESS_KEY_ID');
    const secretAccessKey = value(env, 'S3_SECRET_ACCESS_KEY');
    const missing = [
      ['S3_BUCKET', bucket],
      ['S3_REGION', region],
      ['S3_ACCESS_KEY_ID', accessKeyId],
      ['S3_SECRET_ACCESS_KEY', secretAccessKey],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k as string);
    if (missing.length) {
      return { providerId: 's3', requires: missing, reason: `S3 storage is missing ${missing.join(', ')}.`, build: null };
    }
    return {
      providerId: 's3',
      requires: [],
      reason: 'S3-compatible object storage.',
      build: () =>
        new S3StorageProvider({
          bucket: bucket!,
          region: region!,
          accessKeyId: accessKeyId!,
          secretAccessKey: secretAccessKey!,
          endpoint: value(env, 'S3_ENDPOINT'),
        }),
    };
  }
  return {
    providerId: selected,
    requires: ['STORAGE_PROVIDER'],
    reason: `Unknown storage provider "${selected}". Supported: local, s3.`,
    build: null,
  };
}

function resolveAsr(env: Env): Resolution<TranscriptionProvider> {
  const selected = value(env, 'ASR_PROVIDER');
  if (!selected) {
    return {
      providerId: null,
      requires: ['ASR_PROVIDER'],
      reason: 'No speech-to-text provider selected (ASR_PROVIDER=deepgram|elevenlabs|openai).',
      build: null,
    };
  }
  const keyFor: Record<string, string> = {
    deepgram: 'DEEPGRAM_API_KEY',
    elevenlabs: 'ELEVENLABS_API_KEY',
    openai: 'OPENAI_API_KEY',
  };
  const keyName = keyFor[selected];
  if (!keyName) {
    return {
      providerId: selected,
      requires: ['ASR_PROVIDER'],
      reason: `Unknown ASR provider "${selected}". Supported: deepgram, elevenlabs, openai.`,
      build: null,
    };
  }
  const apiKey = value(env, keyName);
  if (!apiKey) {
    return { providerId: selected, requires: [keyName], reason: `${selected} selected but ${keyName} is not set.`, build: null };
  }
  const model = value(env, 'ASR_MODEL');
  return {
    providerId: selected,
    requires: [],
    reason: `${selected} speech-to-text.`,
    build: () => {
      if (selected === 'deepgram') return new DeepgramTranscriptionProvider({ apiKey, model });
      if (selected === 'elevenlabs') return new ElevenLabsTranscriptionProvider({ apiKey, model });
      return new OpenAiTranscriptionProvider({ apiKey, model });
    },
  };
}

function resolveLlm(env: Env): Resolution<LLMProvider> {
  const selected = value(env, 'LLM_PROVIDER');
  if (!selected) {
    return {
      providerId: null,
      requires: ['LLM_PROVIDER'],
      reason: 'No LLM provider selected (LLM_PROVIDER=anthropic).',
      build: null,
    };
  }
  if (selected !== 'anthropic') {
    return {
      providerId: selected,
      requires: ['LLM_PROVIDER'],
      reason: `Unknown LLM provider "${selected}". Supported: anthropic.`,
      build: null,
    };
  }
  const apiKey = value(env, 'ANTHROPIC_API_KEY');
  if (!apiKey) {
    return { providerId: 'anthropic', requires: ['ANTHROPIC_API_KEY'], reason: 'Anthropic selected but ANTHROPIC_API_KEY is not set.', build: null };
  }
  const effort = value(env, 'LLM_EFFORT') as 'low' | 'medium' | 'high' | undefined;
  return {
    providerId: 'anthropic',
    requires: [],
    reason: `Anthropic ${value(env, 'LLM_MODEL') ?? 'claude-opus-5'}.`,
    build: () => new AnthropicLLMProvider({ apiKey, model: value(env, 'LLM_MODEL'), effort }),
  };
}

function resolveEmbeddings(env: Env): Resolution<EmbeddingsProvider> {
  const selected = value(env, 'EMBEDDINGS_PROVIDER');
  if (!selected) {
    return {
      providerId: null,
      requires: ['EMBEDDINGS_PROVIDER'],
      reason: 'No embeddings provider selected (EMBEDDINGS_PROVIDER=openai). Search falls back to lexical only.',
      build: null,
    };
  }
  if (selected !== 'openai') {
    return { providerId: selected, requires: ['EMBEDDINGS_PROVIDER'], reason: `Unknown embeddings provider "${selected}".`, build: null };
  }
  const apiKey = value(env, 'OPENAI_API_KEY');
  if (!apiKey) {
    return { providerId: 'openai', requires: ['OPENAI_API_KEY'], reason: 'Embeddings selected but OPENAI_API_KEY is not set.', build: null };
  }
  return {
    providerId: 'openai',
    requires: [],
    reason: 'OpenAI embeddings (1536 dimensions).',
    build: () => new OpenAiEmbeddingsProvider({ apiKey, model: value(env, 'EMBEDDINGS_MODEL') }),
  };
}

function resolveSearch(env: Env): Resolution<WebSearchProvider> {
  const selected = value(env, 'WEB_SEARCH_PROVIDER');
  if (!selected) {
    return {
      providerId: null,
      requires: ['WEB_SEARCH_PROVIDER'],
      reason: 'No web search provider selected (WEB_SEARCH_PROVIDER=tavily). Research stays disabled.',
      build: null,
    };
  }
  if (selected !== 'tavily') {
    return { providerId: selected, requires: ['WEB_SEARCH_PROVIDER'], reason: `Unknown search provider "${selected}".`, build: null };
  }
  const apiKey = value(env, 'TAVILY_API_KEY');
  if (!apiKey) {
    return { providerId: 'tavily', requires: ['TAVILY_API_KEY'], reason: 'Tavily selected but TAVILY_API_KEY is not set.', build: null };
  }
  return { providerId: 'tavily', requires: [], reason: 'Tavily web search.', build: () => new TavilySearchProvider(apiKey) };
}

function oauthResolution(env: Env, kind: OAuthKind): Resolution<OAuthClientConfig> {
  const prefix = kind === 'google' ? 'GOOGLE' : 'MICROSOFT';
  const clientId = value(env, `${prefix}_CLIENT_ID`);
  const clientSecret = value(env, `${prefix}_CLIENT_SECRET`);
  const redirectBase = value(env, 'PUBLIC_BASE_URL');
  const missing = [
    [`${prefix}_CLIENT_ID`, clientId],
    [`${prefix}_CLIENT_SECRET`, clientSecret],
    ['PUBLIC_BASE_URL', redirectBase],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k as string);
  if (missing.length) {
    return {
      providerId: kind,
      requires: missing,
      reason: `${kind} OAuth is missing ${missing.join(', ')}.`,
      build: null,
    };
  }
  return {
    providerId: kind,
    requires: [],
    reason: `${kind} OAuth configured.`,
    build: () => ({
      clientId: clientId!,
      clientSecret: clientSecret!,
      redirectUri: `${redirectBase!.replace(/\/$/, '')}/api/v1/integrations/${kind}/callback`,
      tenant: value(env, 'MICROSOFT_TENANT_ID') ?? 'common',
    }),
  };
}

export function createProviderRegistry(env: Env = process.env): ProviderRegistry {
  const storage = resolveStorage(env);
  const asr = resolveAsr(env);
  const llm = resolveLlm(env);
  const embeddings = resolveEmbeddings(env);
  const search = resolveSearch(env);
  const google = oauthResolution(env, 'google');
  const microsoft = oauthResolution(env, 'microsoft');

  const cache = new Map<string, unknown>();
  const build = <T>(kind: ProviderKind | string, resolution: Resolution<T>): T => {
    if (!resolution.build) throw new ProviderNotConfiguredError(kind);
    if (!cache.has(kind)) cache.set(kind, resolution.build());
    return cache.get(kind) as T;
  };

  const byKind: Record<ProviderKind, Resolution<unknown>> = {
    storage,
    asr,
    llm,
    embeddings,
    search,
    calendar: google.build || microsoft.build ? google : microsoft,
    email: google.build || microsoft.build ? google : microsoft,
  };

  return {
    statuses(): ProviderStatus[] {
      const rows: Array<[ProviderKind, Resolution<unknown>]> = [
        ['storage', storage],
        ['asr', asr],
        ['llm', llm],
        ['embeddings', embeddings],
        ['search', search],
        ['calendar', google.build ? google : microsoft],
        ['email', google.build ? google : microsoft],
      ];
      return rows.map(([kind, resolution]) => ({
        kind,
        providerId: resolution.providerId,
        configured: Boolean(resolution.build),
        reason: resolution.reason,
        requires: resolution.requires,
      }));
    },
    isConfigured(kind: ProviderKind): boolean {
      return Boolean(byKind[kind]?.build);
    },
    storage: () => build('storage', storage),
    asr: () => build('asr', asr),
    llm: () => build('llm', llm),
    embeddings: () => build('embeddings', embeddings),
    webSearch: () => build('search', search),
    calendar: (kind) => {
      const resolution = kind === 'google' ? google : microsoft;
      if (!resolution.build) throw new ProviderNotConfiguredError(`calendar:${kind}`);
      return kind === 'google' ? new GoogleCalendarProvider() : new MicrosoftCalendarProvider();
    },
    email: (kind) => {
      const resolution = kind === 'gmail' ? google : microsoft;
      if (!resolution.build) throw new ProviderNotConfiguredError(`email:${kind}`);
      return kind === 'gmail' ? new GmailProvider() : new MicrosoftEmailProvider();
    },
    oauthConfig: (kind) => {
      const resolution = kind === 'google' ? google : microsoft;
      if (!resolution.build) throw new ProviderNotConfiguredError(`oauth:${kind}`);
      return resolution.build();
    },
  };
}
