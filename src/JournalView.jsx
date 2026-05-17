import { useEffect, useRef, useState } from 'react';
import { MoodDot } from './MoodDot.jsx';

function SessionRow({ s, active, onClick }) {
  return (
    <button
      className={'dd-srow ' + (active ? 'on ' : '') + (s.isToday ? 'today ' : '')}
      onClick={onClick}
    >
      <div className="dd-srow-d">
        {s.isToday
          ? <span className="dd-mono dd-today-flag">today</span>
          : <span className="dd-mono">{s.date.slice(5).replace('-', '/')}</span>}
        <span className="dd-srow-t">{s.isToday ? '' : `${s.weekday.slice(0, 3)} · ${s.time}`}</span>
      </div>
      <div className="dd-srow-title"><MoodDot mood={s.mood} />{s.title}</div>
      <div className="dd-srow-meta">{s.duration} · {s.mood}</div>
    </button>
  );
}

function TodayComposer({ onAdd }) {
  const [draft, setDraft] = useState('');
  const ref = useRef(null);

  // Auto-grow as the user types so the textarea reads as flowing prose, not
  // a chat box. Resets after commit.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [draft]);

  const commit = () => {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft('');
  };

  const onKey = (e) => {
    // Cmd/Ctrl-Enter commits; plain Enter still inserts a newline so users
    // can structure their own paragraphs.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className="dd-composer">
      <textarea
        ref={ref}
        className="dd-composer-input"
        placeholder="add to today…"
        value={draft}
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="dd-composer-foot">
        <span className="dd-mono dd-dim">⌘ + return</span>
        <button
          className="dd-composer-save"
          onClick={commit}
          disabled={!draft.trim()}
        >
          save
        </button>
      </div>
    </div>
  );
}

function JournalEntry({ s, onAddToToday }) {
  return (
    <article className="dd-entry">
      <header className="dd-entry-h">
        <div className="dd-entry-date">
          <div className="dd-entry-date-row">
            <h1>{s.weekday}</h1>
            {s.isToday && <span className="dd-today-badge">today</span>}
          </div>
          <span className="dd-mono dd-dim">{s.date}</span>
          <span className="dd-entry-rule" aria-hidden="true">
            <i /><i /><i />
          </span>
        </div>
        <div className="dd-entry-meta">
          <span className="dd-pill"><MoodDot mood={s.mood} />{s.mood}</span>
          <span className="dd-mono dd-dim">{s.time}{s.duration ? ` · ${s.duration}` : ''}</span>
        </div>
      </header>

      <div className="dd-entry-body">
        {s.transcript.length === 0 && !s.isToday && (
          <p className="dd-said dd-dim">— silence —</p>
        )}
        {s.transcript.map((t, i) => (
          t.who === 'a'
            ? <p key={i} className="dd-prompt"><em>— {t.text}</em></p>
            : <p key={i} className="dd-said">{t.text}</p>
        ))}

        {s.isToday && <TodayComposer onAdd={onAddToToday} />}
      </div>
    </article>
  );
}

function RailToggle({ open, onClick }) {
  return (
    <button
      className={'dd-rail-toggle ' + (open ? 'open' : '')}
      onClick={onClick}
      aria-expanded={open}
      aria-label={open ? 'Hide sessions' : 'Show sessions'}
      title={open ? 'Hide sessions' : 'Show sessions'}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d={open
            ? 'M10 3 L4 8 L10 13'
            : 'M5 3 L11 8 L5 13'}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {!open && <span className="dd-mono">sessions</span>}
    </button>
  );
}

export function JournalView({ sessions, activeId, onPick, railOpen, setRailOpen, onAddToToday }) {
  const active = sessions.find((x) => x.id === activeId) || sessions[0];
  return (
    <div className={'dd-journal ' + (railOpen ? 'rail-open' : 'rail-closed')}>
      <aside className="dd-rail">
        <div className="dd-rail-head">
          <span className="dd-rail-title">sessions</span>
          <span className="dd-mono dd-dim">{sessions.length}</span>
        </div>
        <div className="dd-rail-list">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              s={s}
              active={s.id === active.id}
              onClick={() => onPick(s.id)}
            />
          ))}
        </div>
      </aside>
      <main className="dd-main">
        <div className="dd-main-toolbar">
          <RailToggle open={railOpen} onClick={() => setRailOpen(!railOpen)} />
        </div>
        <JournalEntry s={active} onAddToToday={onAddToToday} />
      </main>
    </div>
  );
}
