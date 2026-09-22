import { useCallback, useEffect, useState } from 'react';
import { api, setCsrfToken, type Me } from './api.js';
import { directionFor, type Locale } from './i18n.js';
import { useRoute } from './router.js';
import { Shell } from './components/Shell.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';
import { Meetings } from './pages/Meetings.js';
import { MeetingDetail } from './pages/MeetingDetail.js';
import { Tasks } from './pages/Tasks.js';
import { Search } from './pages/Search.js';
import { Ask } from './pages/Ask.js';
import { Approvals } from './pages/Approvals.js';
import { Research } from './pages/Research.js';
import { SettingsPage } from './pages/Settings.js';

const LOCALE_KEY = 'alia.locale';

function initialLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_KEY);
  return stored === 'ar' || stored === 'en' ? stored : 'en';
}

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const route = useRoute();

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
    return (
      <Login
        locale={locale}
        onAuthenticated={refresh}
        onToggleLocale={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
      />
    );
  }

  const timezone = me.user.timezone;
  const page = (() => {
    switch (route.name) {
      case 'meetings':
        return <Meetings locale={locale} timezone={timezone} />;
      case 'meeting':
        return <MeetingDetail id={route.id} locale={locale} timezone={timezone} />;
      case 'tasks':
        return <Tasks locale={locale} timezone={timezone} />;
      case 'search':
        return <Search locale={locale} />;
      case 'ask':
        return <Ask locale={locale} />;
      case 'research':
        return <Research locale={locale} timezone={timezone} />;
      case 'research-detail':
        return <Research locale={locale} timezone={timezone} detailId={route.id} />;
      case 'approvals':
        return <Approvals locale={locale} timezone={timezone} />;
      case 'settings':
        return <SettingsPage locale={locale} timezone={timezone} />;
      default:
        return <Dashboard me={me} locale={locale} />;
    }
  })();

  return (
    <Shell
      me={me}
      locale={locale}
      route={route}
      onToggleLocale={toggleLocale}
      onSwitchWorkspace={async (id) => {
        await api.switchWorkspace(id);
        await refresh();
      }}
      onSignOut={async () => {
        await api.logout().catch(() => undefined);
        setCsrfToken(null);
        setMe(null);
      }}
    >
      {page}
    </Shell>
  );
}
