const MOOD_COLORS = {
  'tender':            'oklch(0.74 0.09 30)',
  'anxious → settled': 'oklch(0.74 0.09 60)',
  'grateful':          'oklch(0.76 0.10 130)',
  'soft':              'oklch(0.80 0.05 110)',
  'tired':             'oklch(0.68 0.04 280)',
  'restless':          'oklch(0.72 0.10 25)',
  'reflective':        'oklch(0.72 0.07 260)',
  'open':              'var(--accent)',
};

export function MoodDot({ mood }) {
  return (
    <i
      className="dd-mood-dot"
      style={{ background: MOOD_COLORS[mood] || 'oklch(0.7 0.05 80)' }}
    />
  );
}
