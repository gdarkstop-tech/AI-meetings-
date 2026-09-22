import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError, api, type ActionItem, type Decision, type Segment } from '../api.js';
import { formatDateTime, translate, type Locale, type TranslationKey } from '../i18n.js';
import { formatClock, navigate } from '../router.js';

type Insights = Awaited<ReturnType<typeof api.insights>>;
type MeetingDetailData = Awaited<ReturnType<typeof api.meeting>>;

const VISIBLE_STEP = 300;

export function MeetingDetail({ id, locale, timezone }: { id: string; locale: Locale; timezone: string }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [detail, setDetail] = useState<MeetingDetailData | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [visible, setVisible] = useState(VISIBLE_STEP);
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<{ subject: string; body: string; note?: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = () => {
    void api.meeting(id).then(setDetail).catch((err) => setError(err.message));
    void api.transcript(id).then((r) => setSegments(r.segments)).catch(() => undefined);
    void api.insights(id).then(setInsights).catch(() => undefined);
  };
  useEffect(load, [id]);

  const seek = (ms: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = ms / 1000;
    void audio.play().catch(() => undefined);
  };

  const segmentById = useMemo(() => new Map(segments.map((s) => [s.id, s])), [segments]);
  const tldr = insights?.summaries.find((s) => s.kind === 'tldr');
  const executive = insights?.summaries.find((s) => s.kind === 'executive');
  const detailed = insights?.summaries.find((s) => s.kind === 'detailed');

  const evidenceButton = (segmentIds: string[], startMs: number) => (
    <button type="button" className="link-button" title={t('meeting.evidence')} onClick={() => seek(startMs)}>
      ▶ {formatClock(startMs)}
      {segmentIds.length > 0 && segmentById.get(segmentIds[0]) ? ` · “${segmentById.get(segmentIds[0])!.text.slice(0, 60)}…”` : ''}
    </button>
  );

  if (!detail) return <section className="card"><p className="hint">{error ?? t('common.loading')}</p></section>;
  const meeting = detail.meeting;

  return (
    <>
      <section className="card">
        <div className="row">
          <span dir="auto">
            <h2>{meeting.title}</h2>
            <div className="meta">
              {formatDateTime(meeting.created_at, locale, timezone)}
              {meeting.duration_ms ? ` · ${formatClock(Number(meeting.duration_ms))}` : ''}
              {meeting.retention_expires_at
                ? ` · retention: ${formatDateTime(meeting.retention_expires_at, locale, timezone)}`
                : ''}
            </div>
          </span>
          <span className={`badge ${meeting.status === 'ready' ? 'ok' : meeting.status === 'failed' ? 'danger' : 'warn'}`}>
            {meeting.status}
          </span>
        </div>
        {meeting.failure_reason && <p className="error">{meeting.failure_reason}</p>}
        {!meeting.consent_obtained && <p className="error">{t('meetings.consent.required')}</p>}
        {detail.media.length > 0 && (
          <audio ref={audioRef} controls preload="metadata" src={`/api/v1/meetings/${id}/media`} style={{ width: '100%', marginTop: 12 }} />
        )}
        <div className="topbar-actions" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => void api.reprocess(id, 'transcribe').then(load).catch(() => undefined)}>
            {t('meetings.retranscribe')}
          </button>
          <button type="button" onClick={() => void api.reprocess(id, 'analyze').then(load).catch(() => undefined)}>
            {t('meetings.reprocess')}
          </button>
          <button
            type="button"
            onClick={async () => {
              const to = window.prompt('Recipients (comma separated)');
              if (!to) return;
              try {
                const result = await api.followUp(id, to.split(',').map((x) => x.trim()).filter(Boolean));
                setFollowUp({ ...result.draft.email, note: result.reason });
              } catch (err) {
                setError(err instanceof ApiRequestError ? err.error.message : t('error.generic'));
              }
            }}
          >
            {t('meeting.followup')}
          </button>
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (!window.confirm(t('meetings.delete.confirm'))) return;
              await api.deleteMeeting(id);
              navigate('#/meetings');
            }}
          >
            {t('common.delete')}
          </button>
        </div>
        {followUp && (
          <div className="stat" style={{ marginTop: 12 }}>
            <div className="label">{t('meeting.followup')}</div>
            <div className="value" dir="auto">
              <strong>{followUp.subject}</strong>
              <pre className="pre">{followUp.body}</pre>
              {followUp.note && <span className="badge warn">{followUp.note}</span>}
            </div>
          </div>
        )}
      </section>

      {detail.chapters.length > 0 && (
        <section className="card">
          <h2>{t('meeting.chapters')}</h2>
          {detail.chapters.map((chapter) => (
            <div className="row clickable" key={chapter.id} onClick={() => seek(chapter.start_ms)}>
              <span dir="auto">{chapter.title}</span>
              <span className="meta">{formatClock(chapter.start_ms)}</span>
            </div>
          ))}
        </section>
      )}

      {insights && (tldr || executive) && (
        <section className="card">
          <h2>{t('meeting.summary')}</h2>
          {tldr && <p dir="auto">{String((tldr.content as { text?: string }).text ?? '')}</p>}
          {executive && (
            <div className="stat">
              <div className="label">executive</div>
              <div className="value" dir="auto">
                {String((executive.content as { overview?: string }).overview ?? '')}
                <ul>
                  {((executive.content as { topics?: string[] }).topics ?? []).map((topic) => (
                    <li key={topic}>{topic}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {detailed && (
            <details>
              <summary className="meta">detailed</summary>
              {((detailed.content as { sections?: Array<{ heading: string; body: string }> }).sections ?? []).map((section) => (
                <div key={section.heading} dir="auto" style={{ marginTop: 10 }}>
                  <strong>{section.heading}</strong>
                  <p className="hint">{section.body}</p>
                </div>
              ))}
            </details>
          )}
          {tldr && <div className="meta">model: {tldr.model} · prompt: {tldr.promptVersion}</div>}
        </section>
      )}

      {insights && insights.decisions.length > 0 && (
        <section className="card">
          <h2>{t('meeting.decisions')}</h2>
          <p className="hint">{t('meeting.suggested')}</p>
          {insights.decisions.map((decision: Decision) => (
            <div className="row" key={decision.id}>
              <span dir="auto">
                {decision.text}
                <div className="meta">
                  {decision.owner_hint ? `${decision.owner_hint} · ` : ''}
                  {evidenceButton(decision.evidence_segment_ids, decision.start_ms)}
                </div>
              </span>
              <span className="topbar-actions">
                <span className={`badge ${decision.status === 'accepted' ? 'ok' : decision.status === 'rejected' ? 'muted' : 'warn'}`}>
                  {decision.status}
                </span>
                {decision.status === 'suggested' && (
                  <>
                    <button type="button" onClick={() => void api.reviewDecision(decision.id, 'accepted').then(load)}>
                      {t('meeting.accept')}
                    </button>
                    <button type="button" onClick={() => void api.reviewDecision(decision.id, 'rejected').then(load)}>
                      {t('meeting.reject')}
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </section>
      )}

      {insights && insights.actionItems.length > 0 && (
        <section className="card">
          <h2>{t('meeting.actions')}</h2>
          {insights.actionItems.map((item: ActionItem) => (
            <div className="row" key={item.id}>
              <span dir="auto">
                {item.title}
                <div className="meta">
                  {item.assignee_hint ? `${item.assignee_hint} · ` : ''}
                  {item.due_at ? `${new Date(item.due_at).toISOString().slice(0, 10)} ` : ''}
                  {item.due_source_text ? `(${t('meeting.dueFrom')} “${item.due_source_text}”) ` : ''}
                  {evidenceButton([], item.start_ms)}
                </div>
              </span>
              <span className="topbar-actions">
                <span className={`badge ${item.status === 'accepted' ? 'ok' : item.status === 'rejected' ? 'muted' : 'warn'}`}>
                  {item.status}
                </span>
                {item.status === 'suggested' && (
                  <>
                    <button type="button" onClick={() => void api.acceptActionItem(item.id).then(load)}>
                      {t('meeting.accept')}
                    </button>
                    <button type="button" onClick={() => void api.rejectActionItem(item.id).then(load)}>
                      {t('meeting.reject')}
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>{t('meeting.speakers')}</h2>
        {detail.speakers.length === 0 && <p className="hint">{t('common.none')}</p>}
        {[...new Set(segments.map((s) => s.speakerLabel))].map((label) => {
          const mapped = detail.speakers.find((s) => s.speaker_label === label);
          return (
            <div className="row" key={label}>
              <span>{label}</span>
              <span className="topbar-actions">
                {mapped && <span className="badge ok">{mapped.display_name}</span>}
                <button
                  type="button"
                  onClick={async () => {
                    const name = window.prompt(`Name for ${label}`, mapped?.display_name ?? '');
                    if (!name) return;
                    await api.assignSpeaker(id, label, name);
                    load();
                  }}
                >
                  {mapped ? t('common.save') : t('meeting.speakers')}
                </button>
              </span>
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>{t('meeting.transcript')}</h2>
        {segments.length === 0 && <p className="hint">{t('meeting.noTranscript')}</p>}
        {segments.slice(0, visible).map((segment) => (
          <div className="row clickable" key={segment.id} onClick={() => seek(segment.startMs)}>
            <span dir="auto">
              <span className="meta">{segment.speaker} · {formatClock(segment.startMs)}</span>
              <div>{segment.text}</div>
            </span>
            {segment.confidence !== null && <span className="meta">{Math.round(segment.confidence * 100)}%</span>}
          </div>
        ))}
        {segments.length > visible && (
          <button type="button" onClick={() => setVisible((v) => v + VISIBLE_STEP)}>
            +{Math.min(VISIBLE_STEP, segments.length - visible)} / {segments.length}
          </button>
        )}
      </section>
    </>
  );
}
