import { useEffect, useState } from 'react';
import { api, type ActionRow, type Capabilities, type Me, type Meeting, type Task } from '../api.js';
import { formatDateTime, translate, type Locale, type TranslationKey } from '../i18n.js';
import { navigate } from '../router.js';

export function Dashboard({ me, locale }: { me: Me; locale: Locale }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);

  useEffect(() => {
    void api.meetings().then((r) => setMeetings(r.meetings.slice(0, 6))).catch(() => undefined);
    void api.tasks('inbox').then((r) => setTasks(r.tasks.slice(0, 8))).catch(() => undefined);
    void api.actions('proposed').then((r) => setActions(r.actions)).catch(() => undefined);
    void api.capabilities().then(setCapabilities).catch(() => undefined);
  }, []);

  const statusTone = (status: string) =>
    status === 'ready' ? 'ok' : status === 'failed' ? 'danger' : status === 'processing' ? 'warn' : 'muted';

  return (
    <>
      <section className="card">
        <h2>{t('dashboard.today')}</h2>
        <div className="grid">
          <div className="stat">
            <div className="label">{t('dashboard.recent')}</div>
            <div className="value">{meetings.length}</div>
          </div>
          <div className="stat">
            <div className="label">{t('dashboard.pendingTasks')}</div>
            <div className="value">{tasks.length}</div>
          </div>
          <div className="stat">
            <div className="label">{t('dashboard.pendingApprovals')}</div>
            <div className="value">{actions.length}</div>
          </div>
          <div className="stat">
            <div className="label">{t('dashboard.time')}</div>
            <div className="value">{formatDateTime(new Date(), locale, me.user.timezone)}</div>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>{t('dashboard.recent')}</h2>
        {meetings.length === 0 && <p className="hint">{t('meetings.empty')}</p>}
        {meetings.map((meeting) => (
          <div className="row clickable" key={meeting.id} onClick={() => navigate(`#/meetings/${meeting.id}`)}>
            <span dir="auto">
              {meeting.title}
              <div className="meta">{formatDateTime(meeting.created_at, locale, me.user.timezone)}</div>
            </span>
            <span className={`badge ${statusTone(meeting.status)}`}>{meeting.status}</span>
          </div>
        ))}
      </section>

      {actions.length > 0 && (
        <section className="card">
          <h2>{t('dashboard.pendingApprovals')}</h2>
          {actions.map((action) => (
            <div className="row clickable" key={action.id} onClick={() => navigate('#/approvals')}>
              <span dir="auto">
                {action.summary}
                <div className="meta">{action.policyReason}</div>
              </span>
              <span className="badge warn">{action.status}</span>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>{t('dashboard.capabilities')}</h2>
        <p className="hint">{t('dashboard.capabilitiesNote')}</p>
        {capabilities &&
          Object.entries(capabilities.features).map(([feature, status]) => (
            <div className="row" key={feature}>
              <span>{feature}</span>
              <span className={`badge ${status === 'available' ? 'ok' : 'warn'}`}>
                {translate(locale, `status.${status}` as TranslationKey) || status}
              </span>
            </div>
          ))}
      </section>
    </>
  );
}
