import { MiniApp } from './MiniApp.jsx';

function CardHead({ c, accessory }) {
  return (
    <header className="dd-card-h">
      <div>
        <h3>{c.title}</h3>
        <span className="dd-mono dd-dim">{c.sub}</span>
      </div>
      {accessory}
    </header>
  );
}

// ── Mood sparkline ────────────────────────────────────────────────────────
function MoodCard({ c }) {
  // 1 = lowest, 5 = highest. Vertical column dots so the trend reads at a
  // glance without needing axes.
  const max = 5;
  return (
    <div className="dd-card dd-card-mood">
      <CardHead c={c} />
      <div className="dd-mood-chart">
        {c.data.map((v, i) => (
          <div className="dd-mood-col" key={i}>
            {Array.from({ length: max }).map((_, k) => {
              const lvl = max - k;
              const filled = v >= lvl;
              return <i key={k} data-on={filled ? '1' : '0'} />;
            })}
          </div>
        ))}
      </div>
      <div className="dd-mood-axis dd-mono dd-dim">
        <span>14d ago</span><span>today</span>
      </div>
    </div>
  );
}

function PersonCard({ c }) {
  return (
    <div className="dd-card dd-card-person">
      <CardHead c={c} accessory={<span className="dd-tag">{c.sentiment}</span>} />
      <ul className="dd-list">
        {c.notes.map((n, i) => (
          <li key={i}>
            <span className="dd-mono dd-dim">{n.slice(0, 6)}</span>
            <span>{n.slice(8)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectCard({ c }) {
  const done = c.steps.filter((s) => s.done).length;
  return (
    <div className="dd-card dd-card-project">
      <CardHead c={c} accessory={
        <span className="dd-mono dd-dim">{done}/{c.steps.length}</span>
      } />
      <ul className="dd-steps">
        {c.steps.map((s, i) => (
          <li key={i} className={s.done ? 'on' : ''}>
            <i className="dd-check">{s.done ? '✓' : ''}</i>
            <span>{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CountdownCard({ c }) {
  return (
    <div className="dd-card dd-card-cd">
      <CardHead c={c} />
      <div className="dd-cd-num">{c.days}<span className="dd-cd-unit">d</span></div>
      <p className="dd-cd-toast">{c.toast}</p>
    </div>
  );
}

function ThemesCard({ c }) {
  const max = Math.max(...c.items.map((i) => i.count));
  return (
    <div className="dd-card dd-card-themes">
      <CardHead c={c} />
      <ul className="dd-themes">
        {c.items.map((it, i) => (
          <li key={i}>
            <span className="dd-themes-word">{it.word}</span>
            <span className="dd-themes-bar">
              <i style={{ width: `${(it.count / max) * 100}%` }} />
            </span>
            <span className="dd-mono dd-dim">{it.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SleepCard({ c }) {
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return (
    <div className="dd-card dd-card-sleep">
      <CardHead c={c} />
      <div className="dd-sleep">
        {c.nights.map((n, i) => (
          <div className="dd-sleep-col" key={i}>
            <div className="dd-sleep-bar">
              <i
                style={{ height: `${(n.h / 9) * 100}%` }}
                data-late={n.late ? '1' : '0'}
              />
            </div>
            <span className="dd-mono dd-dim">{days[i]}</span>
          </div>
        ))}
      </div>
      <div className="dd-sleep-key dd-mono dd-dim">
        <span><i className="dd-sleep-dot" /> on time</span>
        <span><i className="dd-sleep-dot late" /> after midnight</span>
      </div>
    </div>
  );
}

function LettersCard({ c }) {
  return (
    <div className="dd-card dd-card-letters">
      <CardHead c={c} />
      <ul className="dd-letters">
        {c.drafts.map((d, i) => (
          <li key={i}>
            <span className="dd-mono dd-dim">to {d.to}</span>
            <span className="dd-letters-line">“{d.line}”</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ListCard({ c }) {
  return (
    <div className="dd-card dd-card-list">
      <CardHead c={c} />
      <ul className="dd-bare">
        {c.items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}

const KIND_TO_COMP = {
  mood: MoodCard,
  person: PersonCard,
  project: ProjectCard,
  countdown: CountdownCard,
  themes: ThemesCard,
  sleep: SleepCard,
  letters: LettersCard,
  list: ListCard,
  // `app` is the generative mini-app kind. Its content is a primitive UI tree
  // interpreted at render time, with state mutated by post-call agent passes.
  app: ({ c }) => <MiniApp app={c} />,
};

function RefreshButton({ onClick, refreshing }) {
  return (
    <button
      className={'dd-refresh ' + (refreshing ? 'spinning' : '')}
      onClick={onClick}
      disabled={refreshing}
      aria-label="Regenerate Life OS cards"
      title="Re-author the dashboard from your latest calls. Mini-apps keep their state."
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className="dd-refresh-icon">
        <path d="M13 8 A5 5 0 1 1 11.5 4.5 M13 4.5 L13 8 L9.5 8"
              fill="none" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{refreshing ? 'authoring…' : 'refresh'}</span>
    </button>
  );
}

function EmptyState() {
  return (
    <div style={{
      gridColumn: '1 / -1',
      padding: '48px 24px',
      textAlign: 'center',
      color: 'var(--muted)',
      fontSize: 14, lineHeight: 1.6,
    }}>
      <p style={{ margin: 0, fontFamily: 'var(--display)', fontSize: 17, color: 'var(--ink)' }}>
        Nothing assembled yet.
      </p>
      <p style={{ margin: '8px 0 0', color: 'var(--dim)' }}>
        CB will quietly build small tools here as you keep journaling.
      </p>
    </div>
  );
}

export function DashboardView({ cards, apps = [], onAppUpdated, onRefresh, refreshing }) {
  // Mini-apps from /api/apps come with endpoint_base; cards-as-apps (legacy
  // inline mini-apps in memory.json) do not, so they render read-only. Combine
  // both into one ordered list. Apps from disk come first (they're the active
  // tools), then catalog cards (passive summaries).
  const inlineApps = cards.filter((c) => c.kind === 'app');
  const catalogCards = cards.filter((c) => c.kind !== 'app');
  const widgets = [...apps, ...inlineApps, ...catalogCards];
  const total = widgets.length;

  return (
    <div className="dd-dash">
      <header className="dd-dash-h">
        <div>
          <h1>life, lately</h1>
          <p className="dd-dim">
            small apps the agent has been quietly assembling from your calls.
          </p>
        </div>
        <div className="dd-dash-meta dd-mono dd-dim">
          <span>{total === 1 ? '1 card' : `${total} cards`}</span>
          {onRefresh && <RefreshButton onClick={onRefresh} refreshing={refreshing} />}
        </div>
      </header>
      <div className="dd-grid">
        {total === 0 && <EmptyState />}
        {widgets.map((w) => {
          // Real mini-apps from /api/apps carry endpoint_base; render via the
          // MiniApp wrapper directly so they can dispatch actions.
          if (w.endpoint_base) {
            return (
              <div key={w.id} className={`dd-cell dd-cell-${w.size || 'reg'}`}>
                <MiniApp app={w} onActionResult={onAppUpdated} />
              </div>
            );
          }
          // Everything else: catalog cards + legacy inline apps from memory.json
          const Comp = KIND_TO_COMP[w.kind];
          if (!Comp) return null;
          return (
            <div key={w.id} className={`dd-cell dd-cell-${w.size || 'reg'}`}>
              <Comp c={w} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
