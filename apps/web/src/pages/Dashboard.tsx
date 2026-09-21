import { useEffect, useState } from 'react';
import { api, type Capabilities, type Me } from '../api.js';
import { formatDateTime, translate, type Locale } from '../i18n.js';

interface Props {
  me: Me;
  locale: Locale;
  onRefresh: () => void;
  onSignOut: () => void;
  onToggleLocale: () => void;
}

type AuditEntry = { id: string; action: string; actorType: string; result: string; createdAt: string };

export function Dashboard({ me, locale, onRefresh, onSignOut, onToggleLocale }: Props) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [chainOk, setChainOk] = useState<boolean | null>(null);

  useEffect(() => {
    void api.capabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  useEffect(() => {
    if (!me.currentWorkspaceId || !me.permissions.includes('audit.read')) return;
    const workspaceId = me.currentWorkspaceId;
    void api.audit(workspaceId).then((r) => setAudit(r.entries)).catch(() => setAudit([]));
    void api.auditVerify(workspaceId).then((r) => setChainOk(r.ok)).catch(() => setChainOk(null));
  }, [me.currentWorkspaceId, me.permissions]);

  const statusBadge = (status: string) => {
    const key = `status.${status}` as Parameters<typeof translate>[1];
    const label = translate(locale, key) ?? status;
    const tone = status === 'available' ? 'ok' : status === 'not_configured' ? 'warn' : 'muted';
    return <span className={`badge ${tone}`}>{label}</span>;
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <strong>{t('app.name')}</strong>
          <span>{t('app.phase')}</span>
        </div>
        <div className="topbar-actions">
          {me.workspaces.length > 0 && (
            <select
              aria-label={t('nav.workspace')}
              value={me.currentWorkspaceId ?? ''}
              onChange={async (e) => {
                await api.switchWorkspace(e.target.value);
                onRefresh();
              }}
            >
              {me.workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          )}
          <button type="button" onClick={onToggleLocale}>{t('language.switch')}</button>
          <button type="button" onClick={onSignOut}>{t('nav.signOut')}</button>
        </div>
      </header>

      <section className="card">
        <h2>{t('dashboard.title')}</h2>
        <div className="grid">
          <div className="stat">
            <div className="label">{t('dashboard.welcome')}</div>
            <div className="value" dir="auto">{me.user.name} · {me.user.email}</div>
          </div>
          <div className="stat">
            <div className="label">{t('dashboard.role')}</div>
            <div className="value">{me.role ?? '—'}</div>
          </div>
          <div className="stat">
            <div className="label">{t('dashboard.time')}</div>
            <div className="value">{formatDateTime(new Date(), locale, me.user.timezone)}</div>
          </div>
        </div>
        <div className="tags" style={{ marginTop: 14 }}>
          {me.permissions.map((p) => <span className="tag" key={p}>{p}</span>)}
        </div>
      </section>

      <section className="card">
        <h2>{t('dashboard.capabilities')}</h2>
        <p className="hint">{t('dashboard.capabilitiesNote')}</p>
        {capabilities &&
          Object.entries(capabilities.features).map(([feature, status]) => (
            <div className="row" key={feature}>
              <span>{feature}</span>
              {statusBadge(status)}
            </div>
          ))}
        {capabilities?.providers.map((p) => (
          <div className="row" key={p.kind}>
            <span>
              {p.kind}
              <div className="meta">{p.reason}</div>
            </span>
            <span className="badge warn">phase {p.plannedPhase}</span>
          </div>
        ))}
      </section>

      {me.permissions.includes('audit.read') && (
        <section className="card">
          <h2>{t('dashboard.audit')}</h2>
          {chainOk !== null && (
            <p className="hint">
              <span className={`badge ${chainOk ? 'ok' : 'danger'}`}>
                {chainOk ? t('dashboard.auditVerified') : t('dashboard.auditBroken')}
              </span>
            </p>
          )}
          {audit.map((entry) => (
            <div className="row" key={entry.id}>
              <span>
                {entry.action}
                <div className="meta">{entry.actorType} · {entry.result}</div>
              </span>
              <span className="meta">{formatDateTime(entry.createdAt, locale, me.user.timezone)}</span>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>meetings</h2>
        <p className="hint">{t('dashboard.noMeetings')}</p>
      </section>
    </div>
  );
}
