import { useCallback, useEffect, useState } from 'react';
import { api, setCsrfToken, type Me } from './api.js';
import { directionFor, type Locale } from './i18n.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';

const LOCALE_KEY = 'alia.locale';

function initialLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_KEY);
  return stored === 'ar' || stored === 'en' ? stored : 'en';
}

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  // Direction and language are applied to the document so the whole layout flips.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = directionFor(locale);
    localStorage.setItem(LOCALE_KEY, locale);
  }, [locale]);

  const refresh = useCallback(async () => {
    try {
      const profile = await api.me();
      setCsrfToken(profile.csrfToken);
      setMe(profile);
      setLocale(profile.user.locale);
    } catch {
      setMe(null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleLocale = useCallback(async () => {
    const next: Locale = locale === 'ar' ? 'en' : 'ar';
    setLocale(next);
    if (me) await api.setLocale(next).catch(() => undefined);
  }, [locale, me]);

  if (loading) return <div className="shell" />;

  if (!me) {
    return <Login locale={locale} onAuthenticated={refresh} onToggleLocale={() => setLocale(locale === 'ar' ? 'en' : 'ar')} />;
  }

  return (
    <Dashboard
      me={me}
      locale={locale}
      onRefresh={refresh}
      onToggleLocale={toggleLocale}
      onSignOut={async () => {
        await api.logout().catch(() => undefined);
        setCsrfToken(null);
        setMe(null);
      }}
    />
  );
}
