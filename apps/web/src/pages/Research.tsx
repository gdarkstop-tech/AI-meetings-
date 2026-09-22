import { useEffect, useState } from 'react';
import { ApiRequestError, api } from '../api.js';
import { formatDateTime, translate, type Locale, type TranslationKey } from '../i18n.js';
import { navigate } from '../router.js';

type RequestRow = Awaited<ReturnType<typeof api.research>>['requests'][number];
type Detail = Awaited<ReturnType<typeof api.researchDetail>>;

export function Research({ locale, timezone, detailId }: { locale: Locale; timezone: string; detailId?: string }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => void api.research().then((r) => setRequests(r.requests)).catch(() => undefined);
  useEffect(load, []);
  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    void api.researchDetail(detailId).then(setDetail).catch(() => setDetail(null));
  }, [detailId]);

  if (detailId && detail) {
    return (
      <>
        <section className="card">
          <button type="button" className="link-button" onClick={() => navigate('#/research')}>
            ← {t('common.back')}
          </button>
          <h2 dir="auto">{detail.request.question}</h2>
          <span className={`badge ${detail.request.status === 'completed' ? 'ok' : detail.request.status === 'failed' ? 'danger' : 'warn'}`}>
            {detail.request.status}
          </span>
          {detail.request.failure_reason && <p className="error">{detail.request.failure_reason}</p>}
          {detail.report && <pre className="pre" dir="auto">{detail.report.report_md}</pre>}
          {detail.report && <div className="meta">model: {detail.report.model_version}</div>}
        </section>

        <section className="card">
          <h2>{t('research.sources')}</h2>
          {detail.sources.length === 0 && <p className="hint">{t('common.none')}</p>}
          {detail.sources.map((source) => (
            <div className="row" key={source.id}>
              <span dir="auto">
                <a href={source.url} target="_blank" rel="noreferrer noopener">{source.title ?? source.url}</a>
                <div className="meta">
                  {source.publisher ?? ''} · {t('research.retrieved')} {formatDateTime(source.retrieved_at, locale, timezone)}
                </div>
              </span>
            </div>
          ))}
        </section>
      </>
    );
  }

  return (
    <>
      <section className="card">
        <h2>{t('nav.research')}</h2>
        <p className="hint">{t('research.notConfigured')}</p>
        {error && <p className="error">{error}</p>}
        <div className="topbar-actions">
          <input
            value={question}
            dir="auto"
            placeholder={t('research.ask')}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button
            type="button"
            className="primary"
            onClick={async () => {
              if (question.trim().length < 8) return;
              try {
                await api.requestResearch(question.trim());
                setQuestion('');
                setError(null);
                load();
              } catch (err) {
                setError(err instanceof ApiRequestError ? err.error.message : t('error.generic'));
              }
            }}
          >
            {t('research.submit')}
          </button>
        </div>
      </section>

      <section className="card">
        {requests.length === 0 && <p className="hint">{t('research.none')}</p>}
        {requests.map((request) => (
          <div className="row clickable" key={request.id} onClick={() => navigate(`#/research/${request.id}`)}>
            <span dir="auto">
              {request.question}
              <div className="meta">{formatDateTime(request.created_at, locale, timezone)}</div>
            </span>
            <span className={`badge ${request.status === 'completed' ? 'ok' : request.status === 'failed' ? 'danger' : 'warn'}`}>
              {request.status}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
