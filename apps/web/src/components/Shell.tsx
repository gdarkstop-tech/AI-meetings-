import type { ReactNode } from 'react';
import type { Me } from '../api.js';
import { translate, type Locale, type TranslationKey } from '../i18n.js';
import { navigate, type Route } from '../router.js';

interface Props {
  me: Me;
  locale: Locale;
  route: Route;
  onToggleLocale: () => void;
  onSignOut: () => void;
  onSwitchWorkspace: (id: string) => void;
  children: ReactNode;
}

const NAV: Array<{ path: string; key: TranslationKey; route: Route['name'] }> = [
  { path: '#/', key: 'nav.dashboard', route: 'dashboard' },
  { path: '#/meetings', key: 'nav.meetings', route: 'meetings' },
  { path: '#/tasks', key: 'nav.tasks', route: 'tasks' },
  { path: '#/search', key: 'nav.search', route: 'search' },
  { path: '#/ask', key: 'nav.ask', route: 'ask' },
  { path: '#/approvals', key: 'nav.approvals', route: 'approvals' },
  { path: '#/settings', key: 'nav.settings', route: 'settings' },
];

export function Shell({ me, locale, route, onToggleLocale, onSignOut, onSwitchWorkspace, children }: Props) {
  const t = (key: TranslationKey) => translate(locale, key);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <strong>{t('app.name')}</strong>
          <span>{me.workspaces.find((w) => w.id === me.currentWorkspaceId)?.name ?? ''}</span>
        </div>
        <div className="topbar-actions">
          {me.workspaces.length > 1 && (
            <select
              aria-label={t('nav.workspace')}
              value={me.currentWorkspaceId ?? ''}
              onChange={(e) => onSwitchWorkspace(e.target.value)}
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

      <nav className="tabs">
        {NAV.map((item) => (
          <button
            key={item.path}
            type="button"
            className={route.name === item.route || (item.route === 'meetings' && route.name === 'meeting') ? 'tab active' : 'tab'}
            onClick={() => navigate(item.path)}
          >
            {t(item.key)}
          </button>
        ))}
      </nav>

      <main>{children}</main>
    </div>
  );
}
