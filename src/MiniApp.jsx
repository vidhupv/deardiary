// MiniApp renderer.
//
// A mini-app is a card with: state (JSON), a ui tree of primitives, and update_hints.
// We compute a small set of derived values from state (streak, totals, %), then walk
// the ui tree and dispatch each node to its primitive component.
//
// The renderer is read-only. State mutation happens server-side, after voice calls.

import { PRIMITIVES } from './primitives.jsx';

// ── Derived values ──────────────────────────────────────────────────────────
// Anything a mini-app might want to read but isn't stored — computed once per render
// from `state` and exposed via $.computed.* bindings.
function computeDerivedFor(app) {
  const c = {};
  const s = app.state || {};

  if (Array.isArray(s.completions)) {
    c.completion_count = s.completions.length;
    c.streak = currentStreak(s.completions);
    c.last_completion = s.completions[s.completions.length - 1];
    c.this_week_count = countInThisWeek(s.completions);
  }
  if (Array.isArray(s.target_days)) {
    c.target_days_count = s.target_days.length;
    c.weekly_progress_text = `${c.this_week_count ?? 0}/${s.target_days.length} this week`;
  }
  if (typeof s.target === 'number' && Array.isArray(s.completions)) {
    c.progress_pct = Math.min(100, Math.round((s.completions.length / s.target) * 100));
  }
  // Application tracker: project { name, status } into key_value pairs.
  if (Array.isArray(s.companies)) {
    c.pipeline_pairs = s.companies.map((co) => ({
      key: co.name,
      value: co.status,
      mono: true,
    }));
  }
  // Generic list summary — useful for any state.queue/items array.
  if (Array.isArray(s.queue)) {
    c.queue_count = s.queue.length;
    c.queue_count_text = s.queue.length === 1 ? '1 item' : `${s.queue.length} items`;
  }
  if (Array.isArray(s.completed)) {
    c.completed_count = s.completed.length;
  }
  return c;
}

function countInThisWeek(isoDates) {
  const today = new Date();
  const jsDay = today.getDay();
  const mondayOffset = jsDay === 0 ? -6 : 1 - jsDay;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  // Compare as ISO strings (yyyy-mm-dd sorts correctly) to dodge timezone shenanigans
  // — toISOString returns UTC, so format locally instead.
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const mondayISO = fmt(monday);
  const sundayISO = fmt(sunday);
  return isoDates.filter((iso) => iso >= mondayISO && iso <= sundayISO).length;
}

// Longest run of consecutive days ending today (or yesterday, if today not hit yet).
function currentStreak(isoDates) {
  if (!isoDates || isoDates.length === 0) return 0;
  const set = new Set(isoDates);
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // If today not in set, allow the streak to count from yesterday backwards.
  let cursor = new Date(today);
  if (!set.has(cursor.toISOString().slice(0, 10))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (set.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// ── Render dispatch ─────────────────────────────────────────────────────────
// Exported so primitives that have children (Stack, Grid, Row) can recurse.
export function Render({ node, ctx }) {
  if (!node || typeof node !== 'object') return null;
  const Comp = PRIMITIVES[node.type];
  if (!Comp) {
    // Fallback: surface the broken node so the agent can see + fix on next regen.
    return (
      <span style={{ color: 'var(--muted)', fontSize: 12, fontFamily: 'var(--mono)' }}>
        [unknown primitive: {node.type}]
      </span>
    );
  }
  return <Comp node={node} ctx={ctx} />;
}

// ── Card-shell wrapper, used by DashboardView ───────────────────────────────
// `app` may come from two sources:
//   (a) memory.json cards[] entry with kind:"app" — legacy inline mini-app,
//       state preserved in memory.json, no backend dispatch (read-only).
//   (b) backend/apps/<id>/ on disk — manifest + state + actions.py. These
//       carry an `endpoint_base` field the renderer uses to POST actions.
// onActionResult fires after a successful POST with the fresh app payload so
// the dashboard can swap in the new state without a full refetch.
export function MiniApp({ app, onActionResult, onDelete }) {
  const ctx = {
    state: app.state || {},
    computed: computeDerivedFor(app),
    config: app.config || {},
    // Endpoint base is set by DashboardView when serving from /api/apps.
    // If missing, action primitives render disabled (no backend to hit).
    endpointBase: app.endpoint_base || null,
    onActionResult,
  };
  return (
    <div className="dd-card dd-card-app">
      <header className="dd-card-h">
        <div style={{ minWidth: 0 }}>
          <h3>{app.title}</h3>
          {app.sub && <span className="dd-mono dd-dim">{app.sub}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {app.accessory && <span className="dd-tag">{app.accessory}</span>}
          {onDelete && <DeleteAppButton onClick={onDelete} title={app.title} />}
        </div>
      </header>
      <ErrorBoundary fallback={<BrokenAppFallback app={app} />}>
        <Render node={app.ui} ctx={ctx} />
      </ErrorBoundary>
    </div>
  );
}

function DeleteAppButton({ onClick, title }) {
  return (
    <button
      onClick={onClick}
      aria-label={`Delete ${title}`}
      title="Delete this app"
      style={{
        appearance: 'none', background: 'transparent', cursor: 'pointer',
        border: '0.5px solid var(--line)', borderRadius: 999,
        width: 22, height: 22, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)', opacity: 0.6,
        transition: 'opacity .15s, color .15s, border-color .15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = 1;
        e.currentTarget.style.color = 'var(--ink)';
        e.currentTarget.style.borderColor = 'color-mix(in oklab, var(--ink) 22%, transparent)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = 0.6;
        e.currentTarget.style.color = 'var(--muted)';
        e.currentTarget.style.borderColor = 'var(--line)';
      }}
    >
      <svg viewBox="0 0 14 14" width="9" height="9" aria-hidden="true">
        <path d="M3 3 L11 11 M11 3 L3 11"
              fill="none" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" />
      </svg>
    </button>
  );
}

// ── Failure handling ────────────────────────────────────────────────────────
// One bad mini-app shouldn't break the whole dashboard. If a primitive throws
// (e.g., resolved binding has unexpected shape), swap in a quiet fallback.
import { Component } from 'react';

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.warn('[MiniApp]', err); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function BrokenAppFallback({ app }) {
  return (
    <div style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.5 }}>
      <p style={{ margin: 0 }}>
        Couldn’t render this mini-app. The agent will re-author it on the next refresh.
      </p>
      <p style={{ margin: '6px 0 0', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>
        id: {app.id}
      </p>
    </div>
  );
}
