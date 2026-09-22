import { useEffect, useState } from 'react';
import { ApiRequestError, api, type Capabilities } from '../api.js';
import { formatDateTime, translate, type Locale, type TranslationKey } from '../i18n.js';

type Settings = Awaited<ReturnType<typeof api.settings>>['settings'];
type Costs = Awaited<ReturnType<typeof api.costs>>;
type Integrations = Awaited<ReturnType<typeof api.integrations>>;

export function SettingsPage({ locale, timezone }: { locale: Locale; timezone: string }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [costs, setCosts] = useState<Costs | null>(null);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [memory, setMemory] = useState<Awaited<ReturnType<typeof api.memory>>['entries']>([]);
  const [deletions, setDeletions] = useState<Awaited<ReturnType<typeof api.deletions>>['deletions']>([]);
  const [providers, setProviders] = useState<Capabilities['providers']>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void api.settings().then((r) => setSettings(r.settings)).catch(() => undefined);
    void api.costs().then(setCosts).catch(() => undefined);
    void api.integrations().then((r) => { setIntegrations(r); setProviders(r.providers); }).catch(() => undefined);
    void api.memory().then((r) => setMemory(r.entries)).catch(() => undefined);
    void api.deletions().then((r) => setDeletions(r.deletions)).catch(() => undefined);
  };
  useEffect(load, []);

  const patch = async (change: Record<string, unknown>) => {
    try {
      await api.updateSettings(change);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : t('error.generic'));
    }
  };

  return (
    <>
      {error && <section className="card"><p className="error">{error}</p></section>}

      <section className="card">
        <h2>{t('settings.privacy')}</h2>
        {settings && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.require_recording_consent}
                onChange={(e) => void patch({ requireRecordingConsent: e.target.checked })}
              />
              {t('settings.requireConsent')}
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={settings.ai_enabled} onChange={(e) => void patch({ aiEnabled: e.target.checked })} />
              {t('settings.aiEnabled')}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.external_actions_enabled}
                onChange={(e) => void patch({ externalActionsEnabled: e.target.checked })}
              />
              {t('settings.externalActions')}
            </label>
            <div className="field">
              <label htmlFor="retention">{t('settings.retentionDays')}</label>
              <input
                id="retention"
                type="number"
                min={1}
                defaultValue={settings.retention_days}
                onBlur={(e) => void patch({ retentionDays: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="mediaRetention">{t('settings.mediaRetentionDays')}</label>
              <input
                id="mediaRetention"
                type="number"
                min={1}
                defaultValue={settings.media_retention_days ?? settings.retention_days}
                onBlur={(e) => void patch({ mediaRetentionDays: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="quota">{t('settings.quota')}</label>
              <input
                id="quota"
                type="number"
                min={0}
                defaultValue={settings.monthly_audio_minutes_quota}
                onBlur={(e) => void patch({ monthlyAudioMinutesQuota: Number(e.target.value) })}
              />
            </div>
          </>
        )}
        <a className="link-button" href="/api/v1/workspace/export">{t('settings.export')}</a>
      </section>

      <section className="card">
        <h2>{t('settings.integrations')}</h2>
        {(['google', 'microsoft'] as const).map((kind) => {
          const connected = integrations?.integrations.find((i) => i.kind === kind);
          return (
            <div className="row" key={kind}>
              <span>
                {kind}
                <div className="meta">{connected ? connected.external_account_email ?? connected.status : 'not connected'}</div>
              </span>
              <span className="topbar-actions">
                {connected ? (
                  <button type="button" onClick={() => void api.disconnectIntegration(kind).then(load)}>
                    {t('settings.disconnect')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const { authorizeUrl } = await api.authorizeIntegration(kind, ['calendar', 'email', 'email_send']);
                        window.location.href = authorizeUrl;
                      } catch (err) {
                        setError(err instanceof ApiRequestError ? err.error.message : t('error.generic'));
                      }
                    }}
                  >
                    {t('settings.connect')}
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>{t('settings.providers')}</h2>
        {providers.map((provider) => (
          <div className="row" key={provider.kind}>
            <span>
              {provider.kind}
              <div className="meta">{provider.reason}</div>
            </span>
            <span className={`badge ${provider.configured ? 'ok' : 'warn'}`}>
              {provider.configured ? provider.providerId : provider.requires.join(', ') || 'not configured'}
            </span>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>{t('settings.costs')}</h2>
        {costs && costs.providers.length === 0 && <p className="hint">{t('common.none')}</p>}
        {costs?.providers.map((row) => (
          <div className="row" key={`${row.kind}-${row.provider}`}>
            <span>
              {row.kind} · {row.provider}
              <div className="meta">
                {row.calls} calls · {row.failures} failed · {row.audioMinutes.toFixed(1)} audio minutes
              </div>
            </span>
            <span className="badge muted">${row.costUsd.toFixed(4)}</span>
          </div>
        ))}
        {costs && <div className="meta">total: ${costs.totalCostUsd.toFixed(4)}</div>}
      </section>

      <section className="card">
        <h2>{t('settings.memory')}</h2>
        {memory.length === 0 && <p className="hint">{t('common.none')}</p>}
        {memory.map((entry) => (
          <div className="row" key={entry.id}>
            <span dir="auto">
              {entry.key}
              <div className="meta">{entry.type} · from {entry.source.type} · by {entry.createdBy}</div>
            </span>
            <button type="button" onClick={() => void api.deleteMemory(entry.id).then(load)}>
              {t('common.delete')}
            </button>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>{t('settings.deletions')}</h2>
        {deletions.length === 0 && <p className="hint">{t('common.none')}</p>}
        {deletions.map((row) => (
          <div className="row" key={`${row.target_id}-${row.completed_at}`}>
            <span>
              {row.target_type} · {row.reason}
              <div className="meta">
                {Object.entries(row.artifacts)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(' · ')}
              </div>
            </span>
            <span className="meta">{formatDateTime(row.completed_at, locale, timezone)}</span>
          </div>
        ))}
      </section>
    </>
  );
}
