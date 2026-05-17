// Primitives for mini-apps. Each takes (node, ctx) where node is the JSON
// config from the mini-app's ui tree and ctx is { state, computed }.
// A primitive's contract: read fields off node, optionally resolve $.path
// bindings against ctx, render. No side effects, no fetches.

import { Render } from './MiniApp.jsx';

// ── Binding resolution ──────────────────────────────────────────────────────
// Supports "$.state.completions", "$.computed.streak", "$.config.target_days".
// Returns the resolved value, or undefined if path is broken.
export function resolve(binding, ctx) {
  if (binding == null) return undefined;
  if (typeof binding !== 'string' || !binding.startsWith('$.')) return binding;
  const parts = binding.slice(2).split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Get either a literal value or a $.path binding.
// Convention: any prop that starts with `bind_` or is exactly `bind` is resolved.
function read(node, key, ctx) {
  const bindKey = key === 'value' ? 'bind' : `bind_${key}`;
  if (node[bindKey] !== undefined) return resolve(node[bindKey], ctx);
  return node[key];
}

// ── Layout ──────────────────────────────────────────────────────────────────
function Stack({ node, ctx }) {
  const dir = node.dir === 'h' ? 'row' : 'column';
  const gap = node.gap ?? 10;
  return (
    <div style={{ display: 'flex', flexDirection: dir, gap, minWidth: 0 }}>
      {(node.children || []).map((child, i) => (
        <Render key={i} node={child} ctx={ctx} />
      ))}
    </div>
  );
}

function Grid({ node, ctx }) {
  const cols = node.cols ?? 2;
  const gap = node.gap ?? 8;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gap,
    }}>
      {(node.children || []).map((child, i) => (
        <Render key={i} node={child} ctx={ctx} />
      ))}
    </div>
  );
}

function Row({ node, ctx }) {
  // Convenience: horizontal stack with space-between alignment.
  const align = node.align ?? 'space-between';
  return (
    <div style={{ display: 'flex', justifyContent: align, alignItems: 'baseline', gap: 10 }}>
      {(node.children || []).map((child, i) => (
        <Render key={i} node={child} ctx={ctx} />
      ))}
    </div>
  );
}

// ── Text + headings ─────────────────────────────────────────────────────────
function Heading({ node, ctx }) {
  const text = read(node, 'value', ctx) ?? node.text ?? '';
  return <h4 style={{ fontSize: 13, fontWeight: 500, margin: 0, color: 'var(--ink)' }}>{text}</h4>;
}

function Text({ node, ctx }) {
  const text = read(node, 'value', ctx) ?? node.text ?? '';
  const tone = node.tone ?? 'default';
  const color = tone === 'dim' ? 'var(--dim)' : tone === 'muted' ? 'var(--muted)' : 'var(--ink)';
  const size = node.size ?? 13;
  return <span style={{ color, fontSize: size, lineHeight: 1.4 }}>{text}</span>;
}

function Quote({ node, ctx }) {
  const text = read(node, 'value', ctx) ?? node.text ?? '';
  return (
    <p style={{
      margin: 0, fontStyle: 'italic', fontSize: 13.5, lineHeight: 1.5,
      color: 'var(--muted)', textWrap: 'pretty',
    }}>“{text}”</p>
  );
}

function Label({ node, ctx }) {
  const text = read(node, 'value', ctx) ?? node.text ?? '';
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--dim)',
      textTransform: 'lowercase', letterSpacing: '0.06em',
    }}>{text}</span>
  );
}

// ── Numeric display ─────────────────────────────────────────────────────────
function Counter({ node, ctx }) {
  const value = read(node, 'value', ctx) ?? 0;
  const unit = read(node, 'unit', ctx) ?? '';
  const tone = node.tone ?? 'accent';
  const color = tone === 'accent' ? 'var(--accent)' : 'var(--ink)';
  return (
    <div style={{
      fontFamily: 'var(--display)', fontSize: 56, lineHeight: 0.95,
      letterSpacing: '-0.04em', color, fontWeight: 500, marginTop: 4,
    }}>
      {value}
      {unit && (
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--dim)',
          marginLeft: 6, letterSpacing: 0, fontWeight: 400,
        }}>{unit}</span>
      )}
    </div>
  );
}

function Streak({ node, ctx }) {
  const value = read(node, 'value', ctx) ?? 0;
  const unit = read(node, 'unit', ctx) ?? 'day streak';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{
        fontFamily: 'var(--display)', fontSize: 32, lineHeight: 1,
        letterSpacing: '-0.03em', color: 'var(--accent)', fontWeight: 500,
      }}>{value}</span>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)',
        textTransform: 'lowercase', letterSpacing: '0.06em',
      }}>{unit}</span>
    </div>
  );
}

function Bar({ node, ctx }) {
  const value = read(node, 'value', ctx) ?? 0;
  const max = read(node, 'max', ctx) ?? 1;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div style={{
      height: 4, background: 'color-mix(in oklab, var(--ink) 6%, transparent)',
      borderRadius: 999, overflow: 'hidden',
    }}>
      <div style={{
        width: `${pct}%`, height: '100%', background: 'var(--accent)',
        borderRadius: 999, transition: 'width .3s',
      }} />
    </div>
  );
}

// ── Week / month grids ──────────────────────────────────────────────────────
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Format a Date in local calendar time as yyyy-mm-dd. toISOString() returns UTC
// which silently shifts the date when run after ~5pm Pacific.
function toLocalISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Returns ISO yyyy-mm-dd for the Monday-based current week, offset N days from Mon.
function weekDates(referenceISO) {
  const ref = referenceISO ? new Date(`${referenceISO}T12:00:00`) : new Date();
  const jsDay = ref.getDay();
  const mondayOffset = jsDay === 0 ? -6 : 1 - jsDay;
  const monday = new Date(ref);
  monday.setDate(ref.getDate() + mondayOffset);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return toLocalISO(d);
  });
}

function WeekGrid({ node, ctx }) {
  const completions = read(node, 'completions', ctx) ?? [];
  const targets = read(node, 'targets', ctx) ?? [];
  const reference = read(node, 'reference', ctx);
  const dates = weekDates(reference);
  const completedSet = new Set(completions);
  const targetSet = new Set(targets);
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6,
      padding: '6px 0',
    }}>
      {dates.map((iso, i) => {
        const isTarget = targetSet.has(DAY_KEYS[i]);
        const isDone = completedSet.has(iso);
        const bg = isDone
          ? 'var(--accent)'
          : isTarget
          ? 'color-mix(in oklab, var(--accent) 18%, transparent)'
          : 'color-mix(in oklab, var(--ink) 6%, transparent)';
        const border = isTarget && !isDone ? '0.5px dashed var(--accent)' : '0.5px solid transparent';
        return (
          <div key={iso} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
          }}>
            <div style={{
              width: '100%', aspectRatio: '1', maxWidth: 28,
              background: bg, border, borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: isDone ? 'var(--accent-ink)' : 'var(--dim)',
              fontSize: 10, fontFamily: 'var(--mono)',
            }}>
              {isDone && <span style={{ fontSize: 11 }}>✓</span>}
            </div>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--dim)',
            }}>{DAY_LABELS[i]}</span>
          </div>
        );
      })}
    </div>
  );
}

function MonthGrid({ node, ctx }) {
  const completions = read(node, 'completions', ctx) ?? [];
  const days = read(node, 'days', ctx) ?? 30;
  const set = new Set(completions);
  const today = new Date();
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (days - 1 - i));
    return toLocalISO(d);
  });
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(15, 1fr)', gap: 3,
      padding: '4px 0',
    }}>
      {dates.map((iso) => (
        <div key={iso} style={{
          aspectRatio: '1', borderRadius: 2,
          background: set.has(iso)
            ? 'var(--accent)'
            : 'color-mix(in oklab, var(--ink) 6%, transparent)',
        }} />
      ))}
    </div>
  );
}

// ── List + KeyValue ─────────────────────────────────────────────────────────
function List({ node, ctx }) {
  const items = read(node, 'items', ctx) ?? [];
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' }}>
      {items.map((item, i) => (
        <li key={i} style={{
          padding: '6px 0',
          borderTop: i === 0 ? 0 : '0.5px solid var(--line)',
          fontSize: 13.5, color: 'var(--ink)', textWrap: 'pretty',
        }}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
      ))}
    </ul>
  );
}

function KeyValue({ node, ctx }) {
  const pairs = read(node, 'pairs', ctx) ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {pairs.map((p, i) => (
        <div key={i} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          gap: 12, fontSize: 13,
        }}>
          <span style={{ color: 'var(--muted)' }}>{p.key}</span>
          <span style={{
            color: 'var(--ink)', fontFamily: p.mono ? 'var(--mono)' : 'inherit',
          }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Indicators ──────────────────────────────────────────────────────────────
function Pill({ node, ctx }) {
  const text = read(node, 'value', ctx) ?? node.text ?? '';
  const tone = node.tone ?? 'default';
  const bg = tone === 'accent'
    ? 'color-mix(in oklab, var(--accent) 18%, transparent)'
    : 'var(--surface)';
  const color = tone === 'accent' ? 'var(--accent)' : 'var(--ink)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '3px 8px', borderRadius: 999,
      border: '0.5px solid var(--line)', background: bg, color,
      fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '0.02em',
    }}>{text}</span>
  );
}

function Dot({ node }) {
  const tone = node.tone ?? 'accent';
  const color = tone === 'accent' ? 'var(--accent)' : 'var(--muted)';
  return (
    <i style={{
      display: 'inline-block', width: 6, height: 6, borderRadius: 999,
      background: color,
    }} />
  );
}

// ── Registry ────────────────────────────────────────────────────────────────
export const PRIMITIVES = {
  stack: Stack,
  grid: Grid,
  row: Row,
  heading: Heading,
  text: Text,
  quote: Quote,
  label: Label,
  counter: Counter,
  streak: Streak,
  bar: Bar,
  week_grid: WeekGrid,
  month_grid: MonthGrid,
  list: List,
  key_value: KeyValue,
  pill: Pill,
  dot: Dot,
};
