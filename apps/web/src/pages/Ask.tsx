import { useState } from 'react';
import { ApiRequestError, api } from '../api.js';
import { translate, type Locale, type TranslationKey } from '../i18n.js';
import { formatClock, navigate } from '../router.js';

interface Exchange {
  question: string;
  answer: string;
  sufficient: boolean;
  citations: Array<{ segmentId: string; meetingId: string; meetingTitle: string; speaker: string; startMs: number; quote: string }>;
  model: string;
}

export function Ask({ locale }: { locale: Locale }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<Exchange[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ask(question.trim(), conversationId);
      setConversationId(result.conversationId);
      setHistory((prev) => [
        ...prev,
        {
          question: question.trim(),
          answer: result.answer,
          sufficient: result.sufficient,
          citations: result.citations,
          model: result.model,
        },
      ]);
      setQuestion('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card">
        <h2>{t('nav.ask')}</h2>
        {error && <p className="error">{error}</p>}
        <div className="topbar-actions">
          <input
            value={question}
            dir="auto"
            placeholder={t('ask.placeholder')}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void ask()}
          />
          <button type="button" className="primary" disabled={busy} onClick={() => void ask()}>
            {busy ? t('common.loading') : t('ask.send')}
          </button>
        </div>
      </section>

      {history.map((exchange, index) => (
        <section className="card" key={index}>
          <p className="meta" dir="auto">{exchange.question}</p>
          <p dir="auto">{exchange.answer}</p>
          {!exchange.sufficient && <span className="badge warn">{t('ask.notFound')}</span>}
          {exchange.citations.length > 0 && (
            <>
              <div className="meta" style={{ marginTop: 10 }}>{t('ask.citations')}</div>
              {exchange.citations.map((citation) => (
                <div
                  className="row clickable"
                  key={citation.segmentId}
                  onClick={() => navigate(`#/meetings/${citation.meetingId}`)}
                >
                  <span dir="auto">
                    <span className="meta">
                      {citation.meetingTitle} · {citation.speaker} · {formatClock(citation.startMs)}
                    </span>
                    <div>“{citation.quote}”</div>
                  </span>
                </div>
              ))}
            </>
          )}
          <div className="meta">model: {exchange.model}</div>
        </section>
      ))}
    </>
  );
}
