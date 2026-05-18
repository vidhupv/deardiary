import { useCallback, useEffect, useRef, useState } from 'react';
import { JournalView } from './JournalView.jsx';
import { DashboardView } from './DashboardView.jsx';
import { SESSIONS, LIFEOS_CARDS } from './data.js';

// ── API helpers ───────────────────────────────────────────────────────────────
async function fetchSessions() {
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) return null;
    const { sessions } = await r.json();
    return sessions;
  } catch {
    return null;
  }
}

async function fetchCards() {
  try {
    const r = await fetch('/api/cards');
    if (!r.ok) return null;
    const { cards } = await r.json();
    return cards;
  } catch {
    return null;
  }
}

// Real mini-apps live on disk under backend/apps/<id>/. Each is returned with
// its manifest + current state. We attach endpoint_base here so interactive
// primitives know where to POST their actions.
async function fetchApps() {
  try {
    const r = await fetch('/api/apps');
    if (!r.ok) return null;
    const { apps } = await r.json();
    return (apps || []).map((a) => ({
      ...a,
      kind: 'app',
      endpoint_base: `/api/apps/${a.id}`,
    }));
  } catch {
    return null;
  }
}

async function deleteApp(appId) {
  try {
    const r = await fetch(`/api/apps/${appId}`, { method: 'DELETE' });
    return r.ok;
  } catch {
    return false;
  }
}

async function triggerCall() {
  // The backend uses AMAN_PHONE_NUMBER from .env — no need to send anything.
  const r = await fetch('/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error('Call failed');
  return r.json(); // { call_id, status }
}

async function pollCallStatus(callId) {
  const r = await fetch(`/api/call/${callId}/status`);
  if (!r.ok) return 'unknown';
  const { status } = await r.json();
  return status;
}

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

// call states: idle | confirm | ringing | missed | done
function CallMe({ phone, onCallEnded }) {
  const [state, setState] = useState('idle');
  const ref = useRef(null);
  const pollRef = useRef(null);

  // Close the popup on outside click, but not while a call is in progress.
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        if (state === 'idle' || state === 'confirm') setState('idle');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [state]);

  // Clean up any polling interval when the component unmounts.
  useEffect(() => () => clearInterval(pollRef.current), []);

  const placeCall = async () => {
    setState('ringing');
    try {
      const { call_id } = await triggerCall();
      // Poll status every 4 seconds until the call resolves.
      pollRef.current = setInterval(async () => {
        const status = await pollCallStatus(call_id);
        if (status === 'no_answer' || status === 'busy' || status === 'failed') {
          clearInterval(pollRef.current);
          setState('missed');
        } else if (status === 'completed') {
          clearInterval(pollRef.current);
          setState('done');
          onCallEnded?.(); // refresh sessions in the journal
        }
      }, 4000);
    } catch {
      setState('confirm'); // fall back to confirm dialog on error
    }
  };

  const dismiss = () => setState('idle');

  return (
    <div className="dd-callme-wrap" ref={ref}>
      <button
        className="dd-callme"
        onClick={() => state === 'idle' && setState('confirm')}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" className="dd-callme-icon">
          <path
            d="M6.6 4 L9.3 4 L11 8.3 L8.8 9.6 C 9.8 12.2, 11.8 14.2, 14.4 15.2 L15.7 13 L20 14.7 L20 17.4 C 20 18.7, 18.9 19.8, 17.5 19.7 C 11 19.2, 4.8 13, 4.3 6.5 C 4.2 5.1, 5.3 4, 6.6 4 Z"
            fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinejoin="round" strokeLinecap="round"
          />
        </svg>
        <span>{state === 'ringing' ? 'ringing…' : 'call me'}</span>
      </button>

      {state === 'confirm' && (
        <div className="dd-callme-pop" role="dialog">
          <div className="dd-callme-pop-h">we'll ring you</div>
          <div className="dd-callme-pop-num dd-mono">{phone}</div>
          <div className="dd-callme-pop-actions">
            <button className="dd-btn-primary" onClick={placeCall}>call now</button>
            <button className="dd-btn-ghost" onClick={dismiss}>cancel</button>
          </div>
          <button className="dd-link">use a different number</button>
        </div>
      )}

      {state === 'ringing' && (
        <div className="dd-callme-pop" role="dialog">
          <div className="dd-callme-pop-status" aria-live="polite">
            <i className="dd-pulse" />
            <span>ringing your phone…</span>
          </div>
          <div className="dd-callme-pop-num dd-mono">{phone}</div>
        </div>
      )}

      {state === 'missed' && (
        <div className="dd-callme-pop" role="dialog">
          <div className="dd-callme-pop-h">missed you</div>
          <div className="dd-callme-pop-status dd-dim">
            <span>CB sent you a text instead.</span>
          </div>
          <button className="dd-btn-ghost" onClick={dismiss} style={{ marginTop: 8 }}>ok</button>
        </div>
      )}

      {state === 'done' && (
        <div className="dd-callme-pop" role="dialog">
          <div className="dd-callme-pop-h">good talk.</div>
          <div className="dd-callme-pop-status dd-dim">
            <span>notes are being added to your journal.</span>
          </div>
          <button className="dd-btn-ghost" onClick={dismiss} style={{ marginTop: 8 }}>close</button>
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

// Settings popover. One setting for now: daily call schedule. Loads/saves
// via GET/PUT /api/schedule. The backend's _schedule_loop ticks every 30s
// and fires the call when local time matches.
function Settings() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const ref = useRef(null);

  // Load schedule when popover opens.
  useEffect(() => {
    if (!open) return undefined;
    fetch('/api/schedule')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!s) return;
        setEnabled(!!s.enabled);
        setTime(s.daily_call_time || '');
      })
      .catch(() => {});
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const save = async () => {
    if (enabled && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
      window.alert('Please pick a time before enabling daily calls.');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch('/api/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, daily_call_time: time }),
      });
      if (r.ok) setSavedAt(Date.now());
    } catch {
      /* no-op */
    } finally {
      setSaving(false);
    }
  };

  const saved = savedAt > 0 && Date.now() - savedAt < 2500;

  return (
    <div className="dd-settings-wrap" ref={ref}>
      <button
        className="dd-settings"
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings"
        title="Settings"
      >
        {/* Simple gear */}
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <circle cx="10" cy="10" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          {[0, 60, 120, 180, 240, 300].map((deg) => {
            const a = (deg * Math.PI) / 180;
            return (
              <line
                key={deg}
                x1={10 + Math.cos(a) * 4.4} y1={10 + Math.sin(a) * 4.4}
                x2={10 + Math.cos(a) * 6.6} y2={10 + Math.sin(a) * 6.6}
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
              />
            );
          })}
        </svg>
      </button>

      {open && (
        <div className="dd-settings-pop" role="dialog">
          <div className="dd-settings-h">daily check-in</div>

          <div className="dd-settings-row">
            <span className="dd-settings-label">call me every day</span>
            <button
              className="dd-toggle"
              data-on={enabled ? '1' : '0'}
              onClick={() => setEnabled((e) => !e)}
              aria-pressed={enabled}
              aria-label="Toggle daily call"
            />
          </div>

          <div className="dd-settings-row">
            <span className="dd-settings-label">at</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              disabled={!enabled}
              className="dd-time-input"
            />
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="dd-btn-primary" onClick={save} disabled={saving}>
              {saving ? 'saving…' : saved ? 'saved' : 'save'}
            </button>
            <button className="dd-btn-ghost" onClick={() => setOpen(false)}>close</button>
          </div>

          <div className="dd-settings-note">
            Uses your machine's local time. Backend has to be running for the
            call to fire — keep the server up.
          </div>
        </div>
      )}
    </div>
  );
}

function TopBar({ view, setView, phone, onCallEnded, mode, onToggleMode }) {
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
        <CallMe phone={phone} onCallEnded={onCallEnded} />
        <Settings />
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
  const [cards, setCards] = useState(LIFEOS_CARDS);
  // Mini-apps live on disk under backend/apps/<id>/. We load them alongside
  // the catalog cards array and render both in the dashboard.
  const [apps, setApps] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [agentPhone, setAgentPhone] = useState('(606) 555 — 0117');

  useEffect(() => { applyMode(mode); }, [mode]);

  // Load live data from the backend on mount.
  // Falls back silently to static demo data if the backend isn't running.
  useEffect(() => {
    fetchSessions().then((s) => { if (s) setSessions(s); });
    fetchCards().then((c) => { if (c) setCards(c); });
    fetchApps().then((a) => { if (a) setApps(a); });
    fetch('/api/config')
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.agent_phone_number) setAgentPhone(d.agent_phone_number); })
      .catch(() => {});
  }, []);

  // Called by CallMe when a call completes — refresh everything as the
  // post-call pipeline finishes. Three passes catch the work as it lands:
  //   1.  5s — extract_session_notes is done; new session shows up
  //   2. 15s — update_apps has dispatched any voice-driven actions
  //   3. 35s — gen_cards has regenerated catalog + maybe authored new app
  // Each pass is cheap (just GETs), so over-refetching is fine.
  const onCallEnded = useCallback(() => {
    const refetch = () => {
      fetchSessions().then((s) => { if (s) setSessions(s); });
      fetchCards().then((c) => { if (c) setCards(c); });
      fetchApps().then((a) => { if (a) setApps(a); });
    };
    setTimeout(refetch, 5000);
    setTimeout(refetch, 15000);
    setTimeout(refetch, 35000);
  }, []);

  // Splice a single app's fresh payload into the apps array after a
  // successful action — avoids a full /api/apps refetch on every click.
  const onAppUpdated = useCallback((freshApp) => {
    if (!freshApp?.id) return;
    setApps((prev) => prev.map((a) => (a.id === freshApp.id
      ? { ...freshApp, kind: 'app', endpoint_base: `/api/apps/${freshApp.id}` }
      : a)));
  }, []);

  // Confirm + delete a mini-app. Optimistically removes from state, then
  // posts. If the delete fails (network), we refetch to restore truth.
  const onDeleteApp = useCallback(async (appId, appTitle) => {
    const ok = window.confirm(
      `Delete "${appTitle}"? This removes it from your dashboard. ` +
      `If you mention something it tracked again on a call, CB can rebuild a similar one.`
    );
    if (!ok) return;
    setApps((prev) => prev.filter((a) => a.id !== appId));
    const success = await deleteApp(appId);
    if (!success) {
      const fresh = await fetchApps();
      if (fresh) setApps(fresh);
    }
  }, []);

  // Trigger the backend's gen_cards pass and refetch on success. Catalog cards
  // are reauthored from latest sessions; mini-apps are preserved by id with
  // their accumulated state intact, so this is safe to call as often as needed.
  const onRefreshCards = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch('/api/regenerate-cards', { method: 'POST' });
      if (r.ok) {
        const [freshCards, freshApps] = await Promise.all([fetchCards(), fetchApps()]);
        if (freshCards) setCards(freshCards);
        if (freshApps) setApps(freshApps);
      }
    } catch {
      // Backend unreachable — leave existing cards in place.
    } finally {
      setRefreshing(false);
    }
  }, []);

  const onAddToToday = useCallback(async (text) => {
    // Optimistic update so it appears instantly in the UI.
    setSessions((prev) => prev.map((s) => {
      if (s.id !== 'today') return s;
      return { ...s, transcript: [...s.transcript, { who: 'u', text }] };
    }));
    // Persist to backend — typed entries and voice turns share the same format,
    // so Part 2 reads both without knowing the source.
    try {
      await fetch('/api/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch {
      // Backend down — entry lives in local state only, fine for demo.
    }
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
          phone={agentPhone}
          onCallEnded={onCallEnded}
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
          <DashboardView
            cards={cards}
            apps={apps}
            onAppUpdated={onAppUpdated}
            onDeleteApp={onDeleteApp}
            onRefresh={onRefreshCards}
            refreshing={refreshing}
          />
        )}
      </div>
    </>
  );
}
