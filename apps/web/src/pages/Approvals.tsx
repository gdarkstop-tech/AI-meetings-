import { useEffect, useState } from 'react';
import { ApiRequestError, api, type ActionRow } from '../api.js';
import { formatDateTime, translate, type Locale, type TranslationKey } from '../i18n.js';

export function Approvals({ locale, timezone }: { locale: Locale; timezone: string }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => void api.actions().then((r) => setActions(r.actions)).catch(() => undefined);
  useEffect(load, []);

  const pending = actions.filter((a) => a.status === 'proposed');
  const history = actions.filter((a) => a.status !== 'proposed');

  /** The approver sees the exact payload that will execute, field by field. */
  const renderPayload = (action: ActionRow) => (
    <div className="stat">
      <div className="label">{t('approvals.willSend')}</div>
      <div className="value" dir="auto">
        {Object.entries(action.payload).map(([key, value]) => (
          <div key={key}>
            <span className="meta">{key}: </span>
            <span>{Array.isArray(value) ? value.join(', ') : String(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <section className="card">
        <h2>{t('approvals.title')}</h2>
        {error && <p className="error">{error}</p>}
        {pending.length === 0 && <p className="hint">{t('approvals.none')}</p>}
        {pending.map((action) => (
          <div key={action.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: 12, marginBottom: 12 }}>
            <div className="row">
              <span dir="auto">
                <strong>{action.summary}</strong>
                <div className="meta">
                  {action.type} · {action.requestedVia === 'ai' ? 'proposed by AI' : 'proposed by you'} ·{' '}
                  {formatDateTime(action.createdAt, locale, timezone)}
                </div>
                <div className="meta">{action.policyReason}</div>
              </span>
              {action.dryRun && <span className="badge warn">{t('approvals.dryRun')}</span>}
            </div>
            {renderPayload(action)}
            <div className="topbar-actions" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  try {
                    await api.approveAction(action.id, action.payloadDigest);
                    load();
                  } catch (err) {
                    setError(err instanceof ApiRequestError ? err.error.message : t('error.generic'));
                  }
                }}
              >
                {t('approvals.approve')}
              </button>
              <button
                type="button"
                onClick={async () => {
                  const reason = window.prompt(t('approvals.reject')) ?? 'rejected';
                  await api.rejectAction(action.id, reason);
                  load();
                }}
              >
                {t('approvals.reject')}
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>history</h2>
        {history.length === 0 && <p className="hint">{t('common.none')}</p>}
        {history.map((action) => (
          <div className="row" key={action.id}>
            <span dir="auto">
              {action.summary}
              <div className="meta">
                {action.providerResponseId ? `id: ${action.providerResponseId}` : ''}
                {action.error ? `error: ${action.error.slice(0, 120)}` : ''}
              </div>
            </span>
            <span className={`badge ${action.status === 'executed' ? 'ok' : action.status === 'failed' ? 'danger' : 'muted'}`}>
              {action.status}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
