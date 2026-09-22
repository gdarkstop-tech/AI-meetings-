import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'meetings' }
  | { name: 'meeting'; id: string }
  | { name: 'tasks' }
  | { name: 'search' }
  | { name: 'ask' }
  | { name: 'research' }
  | { name: 'research-detail'; id: string }
  | { name: 'approvals' }
  | { name: 'settings' };

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const [head, param] = clean.split('/');
  switch (head) {
    case 'meetings':
      return param ? { name: 'meeting', id: param } : { name: 'meetings' };
    case 'tasks':
      return { name: 'tasks' };
    case 'search':
      return { name: 'search' };
    case 'ask':
      return { name: 'ask' };
    case 'research':
      return param ? { name: 'research-detail', id: param } : { name: 'research' };
    case 'approvals':
      return { name: 'approvals' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'dashboard' };
  }
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
