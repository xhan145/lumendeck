import type React from 'react';

/** A circular 0–100 readiness gauge. Glow + hue encode the score (info, not decoration). */
export function ReadinessRing({ score, size = 64, label }: { score: number; size?: number; label?: string }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score));
  const dash = (pct / 100) * c;
  const hue = pct >= 80 ? 'var(--md-success)' : pct >= 50 ? 'var(--md-secondary)' : 'var(--md-error)';
  return (
    <div className="readiness-ring" style={{ width: size, height: size, ['--ring-hue' as string]: hue } as React.CSSProperties} title={`${pct}% ready`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ld-border)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={hue}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="readiness-ring-num">{pct}</span>
      {label ? <span className="readiness-ring-label">{label}</span> : null}
    </div>
  );
}
