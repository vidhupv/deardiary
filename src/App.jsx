import { useCallback, useEffect, useRef, useState } from 'react';
import { JournalView } from './JournalView.jsx';
import { DashboardView } from './DashboardView.jsx';
import { SESSIONS, LIFEOS_CARDS } from './data.js';

const MODES = {
  dark: {
    bg: '#111114',
    surface: '#1a1a1f',
    surface2: '#22222a',
    ink: '#ece8df',
    muted: '#888578',
    line: 'rgba(236, 232, 223, 0.10)',
    accent: '#d6b56e',
    accentInk: '#111114',
    dim: 'rgba(236, 232, 223, 0.45)',
    scrollTrack: 'rgba(255,255,255,0.02)',
    scrollThumb: 'rgba(236,232,223,0.16)',
    scrollThumbHover: 'rgba(236,232,223,0.28)',
    paper: 'none',
  },
  light: {
    bg: '#f3ecd9',
    surface: '#faf4e1',
    surface2: '#f0e7cc',
    ink: '#1d1a14',
    muted: '#7e7565',
    line: 'rgba(29, 26, 20, 0.12)',
    accent: '#9a7724',
    accentInk: '#faf4e1',
    dim: 'rgba(29, 26, 20, 0.52)',
    scrollTrack: 'rgba(0,0,0,0.02)',
    scrollThumb: 'rgba(29,26,20,0.20)',
    scrollThumbHover: 'rgba(29,26,20,0.34)',
    paper: 'url(#dd-paper)',
  },
};

function applyMode(mode) {
  const m = MODES[mode] || MODES.dark;
  const r = document.documentElement;
  Object.entries(m).forEach(([k, v]) => {
    const cssKey = '--' + k.replace(/([A-Z])/g, '-$1').toLowerCase();
    r.style.setProperty(cssKey, v);
  });
  r.setAttribute('data-mode', mode);
  r.style.colorScheme = mode === 'dark' ? 'dark' : 'light';
}

function CallMe({ phone }) {
  const [open, setOpen] = useState(false);
  const [ringing, setRinging] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        // Suppress click-outside while the simulated call is in flight.
        if (!ringing) setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, ringing]);

  const placeCall = () => {
    setRinging(true);
    setTimeout(() => {
      setRinging(false);
      setOpen(false);
    }, 2400);
  };

  return (
    <div className="dd-callme-wrap" ref={ref}>
      <button className="dd-callme" onClick={() => setOpen((o) => !o)}>
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          aria-hidden="true"
          className="dd-callme-icon"
        >
          <path
            d="M6.6 4 L9.3 4 L11 8.3 L8.8 9.6 C 9.8 12.2, 11.8 14.2, 14.4 15.2 L15.7 13 L20 14.7 L20 17.4 C 20 18.7, 18.9 19.8, 17.5 19.7 C 11 19.2, 4.8 13, 4.3 6.5 C 4.2 5.1, 5.3 4, 6.6 4 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        <span>{ringing ? 'ringing…' : 'call me'}</span>
      </button>

      {open && (
        <div className="dd-callme-pop" role="dialog">
          {ringing ? (
            <>
              <div className="dd-callme-pop-status" aria-live="polite">
                <i className="dd-pulse" />
                <span>ringing your phone…</span>
              </div>
              <div className="dd-callme-pop-num dd-mono">{phone}</div>
            </>
          ) : (
            <>
              <div className="dd-callme-pop-h">we’ll ring you</div>
              <div className="dd-callme-pop-num dd-mono">{phone}</div>
              <div className="dd-callme-pop-actions">
                <button className="dd-btn-primary" onClick={placeCall}>call now</button>
                <button className="dd-btn-ghost" onClick={() => setOpen(false)}>cancel</button>
              </div>
              <button className="dd-link">use a different number</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ModeToggle({ mode, onClick }) {
  const isDark = mode === 'dark';
  return (
    <button
      className="dd-mode"
      onClick={onClick}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
    >
      {isDark ? (
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <circle cx="10" cy="10" r="3" fill="currentColor" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
            const a = (deg * Math.PI) / 180;
            return (
              <line
                key={deg}
                x1={10 + Math.cos(a) * 5.6}
                y1={10 + Math.sin(a) * 5.6}
                x2={10 + Math.cos(a) * 7.4}
                y2={10 + Math.sin(a) * 7.4}
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            );
          })}
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <path
            d="M14.7 12.7 A6.2 6.2 0 1 1 8.5 4.4 A5 5 0 0 0 14.7 12.7 Z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}

function TopBar({ view, setView, phone, mode, onToggleMode }) {
  return (
    <header className="dd-top">
      <div className="dd-brand">
        <span className="dd-wordmark">
          <span className="dd-wordmark-l">dear</span>
          <span className="dd-wordmark-r">diary</span>
        </span>
      </div>

      <nav className="dd-nav">
        <button
          data-on={view === 'journal' ? '1' : '0'}
          aria-pressed={view === 'journal'}
          onClick={() => setView('journal')}
        >
          Journal
        </button>
        <button
          data-on={view === 'dash' ? '1' : '0'}
          aria-pressed={view === 'dash'}
          onClick={() => setView('dash')}
        >
          Life OS
        </button>
      </nav>

      <div className="dd-top-r">
        <CallMe phone={phone} />
        <ModeToggle mode={mode} onClick={onToggleMode} />
      </div>
    </header>
  );
}

export function App() {
  const [mode, setMode] = useState('dark');
  const [view, setView] = useState('journal');
  const [activeId, setActiveId] = useState('today');
  const [railOpen, setRailOpen] = useState(false);
  const [sessions, setSessions] = useState(SESSIONS);

  useEffect(() => { applyMode(mode); }, [mode]);

  const onAddToToday = useCallback((text) => {
    setSessions((prev) => prev.map((s) => {
      if (s.id !== 'today') return s;
      return { ...s, transcript: [...s.transcript, { who: 'u', text }] };
    }));
  }, []);

  return (
    <>
      <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute' }}>
        <filter id="dd-paper">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 0.10  0 0 0 0 0.08  0 0 0 0 0.05  0 0 0 0.05 0" />
        </filter>
      </svg>

      <div className="dd-app">
        <TopBar
          view={view}
          setView={setView}
          phone="(606) 555 — 0117"
          mode={mode}
          onToggleMode={() => setMode(mode === 'dark' ? 'light' : 'dark')}
        />
        {view === 'journal' ? (
          <JournalView
            sessions={sessions}
            activeId={activeId}
            onPick={setActiveId}
            railOpen={railOpen}
            setRailOpen={setRailOpen}
            onAddToToday={onAddToToday}
          />
        ) : (
          <DashboardView cards={LIFEOS_CARDS} />
        )}
      </div>
    </>
  );
}
