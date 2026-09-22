import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, api, type Meeting } from '../api.js';
import { formatDateTime, translate, type Locale, type TranslationKey } from '../i18n.js';
import { formatClock, navigate } from '../router.js';

type ConsentMethod = 'verbal' | 'written' | 'implied_policy' | 'not_required';

/** Uploads a blob through the resumable chunk API, resuming what already exists. */
async function uploadBlob(
  meetingId: string,
  blob: Blob,
  filename: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  const init = await api.initUpload(meetingId, {
    filename,
    mimeType: blob.type || 'audio/webm',
    totalBytes: blob.size,
  });
  const done = new Set(init.receivedChunks);
  for (let index = 0; index < init.chunkCount; index += 1) {
    if (done.has(index)) continue;
    const start = index * init.chunkSize;
    await api.putChunk(meetingId, init.uploadId, index, blob.slice(start, start + init.chunkSize));
    onProgress(Math.round(((index + 1) / init.chunkCount) * 100));
  }
  await api.completeUpload(meetingId, init.uploadId);
}

export function Meetings({ locale, timezone }: { locale: Locale; timezone: string }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<'ar' | 'en' | 'mixed'>('mixed');
  const [consentObtained, setConsentObtained] = useState(false);
  const [consentMethod, setConsentMethod] = useState<ConsentMethod>('verbal');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const [recording, setRecording] = useState<'idle' | 'recording' | 'paused'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const meetingRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const refresh = () => void api.meetings().then((r) => setMeetings(r.meetings)).catch(() => undefined);
  useEffect(refresh, []);

  const createMeeting = async (source: 'upload' | 'live_recording') => {
    const created = await api.createMeeting({
      title: title.trim() || 'Untitled meeting',
      language,
      source,
      consent: consentObtained ? { obtained: true, method: consentMethod } : { obtained: false },
    });
    return created.meeting;
  };

  const onPickFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const meeting = await createMeeting('upload');
      await uploadBlob(meeting.id, file, file.name, setProgress);
      setTitle('');
      setProgress(null);
      refresh();
      navigate(`#/meetings/${meeting.id}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const startRecording = async () => {
    setError(null);
    try {
      const meeting = await createMeeting('live_recording');
      meetingRef.current = meeting.id;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      setRecording('recording');
      setElapsed(0);
      timerRef.current = window.setInterval(() => setElapsed((value) => value + 1000), 1000);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : (err as Error).message);
    }
  };

  const stopRecording = async () => {
    const recorder = recorderRef.current;
    const meetingId = meetingRef.current;
    if (!recorder || !meetingId) return;
    if (timerRef.current) window.clearInterval(timerRef.current);
    setBusy(true);
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    recorder.stream.getTracks().forEach((track) => track.stop());
    setRecording('idle');
    try {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      await uploadBlob(meetingId, blob, 'recording.webm', setProgress);
      refresh();
      navigate(`#/meetings/${meetingId}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : t('error.generic'));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const statusTone = (status: string) =>
    status === 'ready' ? 'ok' : status === 'failed' ? 'danger' : status === 'processing' ? 'warn' : 'muted';

  return (
    <>
      <section className="card">
        <h2>{t('meetings.new')}</h2>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="field">
          <label htmlFor="title">{t('meetings.title')}</label>
          <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" />
        </div>
        <div className="field">
          <label htmlFor="lang">{t('meetings.language')}</label>
          <select id="lang" value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
            <option value="mixed">{t('meetings.language.mixed')}</option>
            <option value="ar">{t('meetings.language.ar')}</option>
            <option value="en">{t('meetings.language.en')}</option>
          </select>
        </div>

        <div className="field">
          <label>{t('meetings.consent')}</label>
          <p className="hint">{t('meetings.consent.required')}</p>
          <label className="checkbox">
            <input type="checkbox" checked={consentObtained} onChange={(e) => setConsentObtained(e.target.checked)} />
            {t('meetings.consent.obtained')}
          </label>
          {consentObtained && (
            <select value={consentMethod} onChange={(e) => setConsentMethod(e.target.value as ConsentMethod)}>
              <option value="verbal">{t('meetings.consent.verbal')}</option>
              <option value="written">{t('meetings.consent.written')}</option>
              <option value="implied_policy">{t('meetings.consent.implied_policy')}</option>
              <option value="not_required">{t('meetings.consent.not_required')}</option>
            </select>
          )}
        </div>

        <div className="topbar-actions">
          <label className="button-like">
            {t('meetings.upload')}
            <input
              type="file"
              accept="audio/*,video/*"
              hidden
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onPickFile(file);
              }}
            />
          </label>
          {recording === 'idle' ? (
            <button type="button" className="primary" disabled={busy} onClick={() => void startRecording()}>
              {t('meetings.record')}
            </button>
          ) : (
            <>
              <span className="badge danger">● {t('meetings.recording')} {formatClock(elapsed)}</span>
              <button
                type="button"
                onClick={() => {
                  const recorder = recorderRef.current;
                  if (!recorder) return;
                  if (recording === 'recording') {
                    recorder.pause();
                    setRecording('paused');
                  } else {
                    recorder.resume();
                    setRecording('recording');
                  }
                }}
              >
                {recording === 'recording' ? t('meetings.pause') : t('meetings.resume')}
              </button>
              <button type="button" className="primary" onClick={() => void stopRecording()}>
                {t('meetings.stop')}
              </button>
            </>
          )}
          {progress !== null && <span className="badge warn">{t('meetings.uploading')} {progress}%</span>}
        </div>
      </section>

      <section className="card">
        <h2>{t('nav.meetings')}</h2>
        {meetings.length === 0 && <p className="hint">{t('meetings.empty')}</p>}
        {meetings.map((meeting) => (
          <div className="row clickable" key={meeting.id} onClick={() => navigate(`#/meetings/${meeting.id}`)}>
            <span dir="auto">
              {meeting.title}
              <div className="meta">
                {formatDateTime(meeting.created_at, locale, timezone)}
                {meeting.duration_ms ? ` · ${formatClock(Number(meeting.duration_ms))}` : ''}
                {meeting.consent_obtained ? '' : ' · ⚠ no consent recorded'}
              </div>
            </span>
            <span className={`badge ${statusTone(meeting.status)}`}>
              {meeting.status}
              {meeting.failure_reason ? ` — ${meeting.failure_reason.slice(0, 40)}` : ''}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
