import { useEffect, useState } from 'react';
import { api, type Task } from '../api.js';
import { formatDateTime, translate, type Locale, type TranslationKey } from '../i18n.js';
import { navigate } from '../router.js';

const VIEWS: Array<{ id: string; key: TranslationKey }> = [
  { id: 'inbox', key: 'tasks.view.inbox' },
  { id: 'today', key: 'tasks.view.today' },
  { id: 'upcoming', key: 'tasks.view.upcoming' },
  { id: 'overdue', key: 'tasks.view.overdue' },
  { id: 'completed', key: 'tasks.view.completed' },
];

export function Tasks({ locale, timezone }: { locale: Locale; timezone: string }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [view, setView] = useState('inbox');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [title, setTitle] = useState('');

  const load = (next = view) => {
    void api.tasks(next).then((r) => {
      setTasks(r.tasks);
      setCounts(r.counts);
    });
  };
  useEffect(() => load(view), [view]);

  return (
    <>
      <section className="card">
        <h2>{t('tasks.title')}</h2>
        <div className="tabs">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? 'tab active' : 'tab'}
              onClick={() => setView(item.id)}
            >
              {t(item.key)}
            </button>
          ))}
        </div>
        <div className="topbar-actions" style={{ marginTop: 12 }}>
          <input
            value={title}
            placeholder={t('tasks.new')}
            dir="auto"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key !== 'Enter' || !title.trim()) return;
              await api.createTask({ title: title.trim() });
              setTitle('');
              load();
            }}
          />
        </div>
        <div className="tags" style={{ marginTop: 10 }}>
          {Object.entries(counts).map(([status, count]) => (
            <span className="tag" key={status}>{status}: {count}</span>
          ))}
        </div>
      </section>

      <section className="card">
        {tasks.length === 0 && <p className="hint">{t('common.none')}</p>}
        {tasks.map((task) => (
          <div className="row" key={task.id}>
            <span dir="auto">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={task.status === 'DONE'}
                  onChange={async (e) => {
                    await api.updateTask(task.id, { status: e.target.checked ? 'DONE' : 'TODO' });
                    load();
                  }}
                />
                <span className={task.status === 'DONE' ? 'done' : ''}>{task.title}</span>
              </label>
              <div className="meta">
                {task.due_at ? formatDateTime(task.due_at, locale, timezone) : '—'}
                {task.source_meeting_id && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => navigate(`#/meetings/${task.source_meeting_id}`)}
                    >
                      {t('tasks.fromMeeting')}
                    </button>
                  </>
                )}
              </div>
            </span>
            <span className={`badge ${task.priority === 'urgent' || task.priority === 'high' ? 'warn' : 'muted'}`}>
              {task.priority}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
