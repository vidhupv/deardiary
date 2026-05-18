// Primitives for mini-apps. Each takes (node, ctx) where node is the JSON
// config from the mini-app's ui tree and ctx is { state, computed, ... }.
// A primitive's contract: read fields off node, optionally resolve $.path
// bindings against ctx, render. Interactive primitives may POST to
// ctx.endpointBase/<action> and call ctx.onActionResult(fresh_app) with the
// response so the dashboard can swap in the new state.

import { useState } from 'react';
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

// ── Interactive primitives ──────────────────────────────────────────────────
// These actually call the backend. Each app's endpoint base is
// ctx.endpointBase ("/api/apps/<id>"). On success we call ctx.onActionResult
// with the fresh app payload returned by the server (which includes the
// updated state), so the dashboard re-renders without a full refetch.

async function dispatchAction(ctx, action, body) {
  if (!ctx.endpointBase) {
    console.warn('[mini-app] no endpointBase; action ignored', action);
    return null;
  }
  try {
    const r = await fetch(`${ctx.endpointBase}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
      console.warn('[mini-app] action failed', action, r.status);
      return null;
    }
    const fresh = await r.json();
    ctx.onActionResult?.(fresh);
    return fresh;
  } catch (e) {
    console.warn('[mini-app] action error', action, e);
    return null;
  }
}

function TextInput({ node, ctx }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const field = node.field || 'text';
  const action = node.action;

  const submit = async () => {
    const v = value.trim();
    if (!v || !action || busy) return;
    setBusy(true);
    await dispatchAction(ctx, action, { [field]: v });
    setValue('');
    setBusy(false);
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  const disabled = !ctx.endpointBase || !action;

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        placeholder={node.placeholder || 'add an item…'}
        disabled={disabled || busy}
        style={{
          flex: 1, minWidth: 0,
          appearance: 'none', outline: 'none',
          background: 'transparent', color: 'var(--ink)',
          fontFamily: 'var(--sans)', fontSize: 13, lineHeight: 1.4,
          padding: '6px 0',
          border: 0, borderBottom: '0.5px dashed var(--line)',
          transition: 'border-color .15s',
        }}
        onFocus={(e) => e.target.style.borderBottomColor = 'var(--accent)'}
        onBlur={(e) => e.target.style.borderBottomColor = 'var(--line)'}
      />
      <button
        onClick={submit}
        disabled={disabled || busy || !value.trim()}
        style={{
          appearance: 'none', cursor: busy ? 'default' : 'pointer',
          background: 'var(--ink)', color: 'var(--bg)',
          font: '500 11px/1 var(--sans)',
          padding: '6px 12px', borderRadius: 999, border: 0,
          letterSpacing: '0.01em',
          opacity: (disabled || !value.trim() || busy) ? 0.35 : 1,
        }}
      >
        {busy ? '…' : (node.submit_label || 'add')}
      </button>
    </div>
  );
}

function CheckboxList({ node, ctx }) {
  const items = read(node, 'items', ctx) ?? [];
  const labelField = node.item_label_field || 'text';
  const idField = node.item_id_field || 'id';
  const action = node.on_check_action;
  const empty = node.empty_text || 'nothing yet';
  const [pending, setPending] = useState(null); // id of item being checked

  const onCheck = async (item) => {
    if (!action) return;
    const id = item?.[idField];
    if (!id) return;
    setPending(id);
    await dispatchAction(ctx, action, { [idField]: id });
    setPending(null);
  };

  if (!items.length) {
    return (
      <p style={{
        margin: 0, color: 'var(--dim)', fontSize: 12.5, fontStyle: 'italic',
      }}>{empty}</p>
    );
  }
  return (
    <ul style={{
      listStyle: 'none', padding: 0, margin: 0,
      display: 'flex', flexDirection: 'column',
    }}>
      {items.map((item, i) => {
        const id = item?.[idField] ?? i;
        const label = item?.[labelField] ?? String(item);
        const isPending = pending === id;
        return (
          <li key={id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '7px 0',
            borderTop: i === 0 ? 0 : '0.5px solid var(--line)',
            opacity: isPending ? 0.5 : 1,
            transition: 'opacity .15s',
          }}>
            <button
              onClick={() => onCheck(item)}
              disabled={isPending || !action}
              aria-label={`mark "${label}" done`}
              style={{
                width: 16, height: 16, flexShrink: 0,
                borderRadius: 4, border: '0.5px solid var(--line)',
                background: 'transparent', cursor: action ? 'pointer' : 'default',
                padding: 0, color: 'var(--accent)',
                fontSize: 11, lineHeight: 1,
              }}
            >
              {isPending ? '·' : ''}
            </button>
            <span style={{
              fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.4,
              wordBreak: 'break-word', minWidth: 0,
            }}>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ActionButton({ node, ctx }) {
  const [busy, setBusy] = useState(false);
  const action = node.action;
  const label = node.label || node.text || 'do it';

  const click = async () => {
    if (!action || busy) return;
    setBusy(true);
    await dispatchAction(ctx, action, node.body || {});
    setBusy(false);
  };
  const disabled = !ctx.endpointBase || !action;

  return (
    <button
      onClick={click}
      disabled={disabled || busy}
      style={{
        appearance: 'none',
        cursor: (disabled || busy) ? 'default' : 'pointer',
        background: node.tone === 'ghost' ? 'transparent' : 'var(--ink)',
        color: node.tone === 'ghost' ? 'var(--muted)' : 'var(--bg)',
        border: node.tone === 'ghost' ? '0.5px solid var(--line)' : 0,
        font: '500 11px/1 var(--sans)',
        padding: '6px 12px', borderRadius: 999,
        letterSpacing: '0.01em',
        opacity: (disabled || busy) ? 0.35 : 1,
        alignSelf: 'flex-start',
      }}
    >
      {busy ? '…' : label}
    </button>
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
  // Interactive — POST to ctx.endpointBase/<action>
  text_input: TextInput,
  checkbox_list: CheckboxList,
  button: ActionButton,
};
