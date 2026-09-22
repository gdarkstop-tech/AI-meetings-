import { useState } from 'react';
import { api, type SearchHit } from '../api.js';
import { translate, type Locale, type TranslationKey } from '../i18n.js';
import { formatClock, navigate } from '../router.js';

export function Search({ locale }: { locale: Locale }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const result = await api.search(query);
      setHits(result.hits);
      setDegraded(result.degradedReason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card">
        <h2>{t('nav.search')}</h2>
        <div className="topbar-actions">
          <input
            value={query}
            dir="auto"
            placeholder={t('search.placeholder')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void run()}
          />
          <button type="button" className="primary" disabled={busy} onClick={() => void run()}>
            {t('nav.search')}
          </button>
        </div>
        {degraded && <p className="hint">⚠ {degraded}</p>}
      </section>

      <section className="card">
        <h2>{t('search.results')} ({hits.length})</h2>
        {hits.length === 0 && <p className="hint">{t('common.none')}</p>}
        {hits.map((hit) => (
          <div
            className="row clickable"
            key={`${hit.type}-${hit.id}`}
            onClick={() => hit.meetingId && navigate(`#/meetings/${hit.meetingId}`)}
          >
            <span dir="auto">
              <span className="meta">
                {hit.type} · {hit.meetingTitle ?? ''} {hit.startMs !== null ? `· ${formatClock(hit.startMs)}` : ''}
              </span>
              <div>{hit.snippet}</div>
            </span>
            <span className="tags">
              {hit.matchedBy.map((m) => (
                <span className="tag" key={m}>{m}</span>
              ))}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
