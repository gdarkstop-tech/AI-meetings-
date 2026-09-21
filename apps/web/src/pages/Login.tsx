import { useState, type FormEvent } from 'react';
import { ApiRequestError, api, setCsrfToken } from '../api.js';
import { translate, type Locale } from '../i18n.js';

interface Props {
  locale: Locale;
  onAuthenticated: () => void;
  onToggleLocale: () => void;
}

export function Login({ locale, onAuthenticated, onToggleLocale }: Props) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register({ email, name, password, locale });
      setCsrfToken(result.csrfToken);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell">
      <div className="auth">
        <div className="topbar">
          <div className="brand">
            <strong>{t('app.name')}</strong>
            <span>{t('app.phase')}</span>
          </div>
          <button type="button" onClick={onToggleLocale}>{t('language.switch')}</button>
        </div>
        <h1>{mode === 'login' ? t('auth.signIn') : t('auth.signUp')}</h1>
        <p className="tagline">{t('auth.tagline')}</p>

        <form onSubmit={submit} className="card">
          {error && <p className="error" role="alert">{error}</p>}
          {mode === 'register' && (
            <div className="field">
              <label htmlFor="name">{t('auth.name')}</label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)} required dir="auto" />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">{t('auth.email')}</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required dir="ltr" />
          </div>
          <div className="field">
            <label htmlFor="password">{t('auth.password')}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              dir="ltr"
            />
            <span className="hint">{t('auth.passwordHint')}</span>
          </div>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? t('auth.submitting') : mode === 'login' ? t('auth.signIn') : t('auth.signUp')}
          </button>
        </form>

        <button
          type="button"
          className="link-button"
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
        >
          {mode === 'login' ? t('auth.toggleToRegister') : t('auth.toggleToLogin')}
        </button>
      </div>
    </div>
  );
}
