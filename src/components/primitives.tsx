import React from 'react';
import { IconArrowDown } from './icons';

// ————————————————————————————————————————————————————————————————
// Shared primitives — Page, Card, Chip, Btn, StepLabel, Field,
// SelectBox, Toggle, SumRow, plus form style tokens.
// Used by Buy Create (and soon Overview, Action, Inventory, etc.)
// ————————————————————————————————————————————————————————————————

export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(' ');

// ——— Form style tokens ———

export const inpStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  background: 'rgba(255, 248, 222, 0.35)',
  border: '1px solid rgba(180, 140, 60, 0.2)',
  fontSize: 13,
  outline: 'none',
  color: 'var(--ink)',
  fontFamily: 'inherit',
  transition: 'all 0.15s ease',
  boxSizing: 'border-box',
};

export const fieldLabel: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
  fontWeight: 600,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
};

export const linkRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 10,
  background: 'rgba(255, 248, 222, 0.35)',
  border: '1px solid rgba(180, 140, 60, 0.2)',
  boxSizing: 'border-box',
};

export const partyLink: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  marginTop: 8,
  fontSize: 11,
  color: 'var(--ink-3)',
  textDecoration: 'none',
};

// ——— Page scaffold ———

type PageProps = {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  tag?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
};

export const Page: React.FC<PageProps> = ({ title, subtitle, tag, actions, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
    <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
      <div>
        {tag && <Chip tone="gold" style={{ marginBottom: 12 }}>{tag}</Chip>}
        <h1 style={{ margin: 0, fontSize: 40, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1 }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ margin: '10px 0 0', color: 'var(--ink-2)', fontSize: 14, maxWidth: 620, lineHeight: 1.5 }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{actions}</div>}
    </header>
    {children}
  </div>
);

// ——— Card ———

type CardProps = {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  strong?: boolean;
  layered?: boolean;
  label?: React.ReactNode;
  actions?: React.ReactNode;
};

export const Card: React.FC<CardProps> = ({ children, style, strong, layered, label, actions }) => (
  <section
    className={cx(strong ? 'glass-strong' : 'glass', layered && 'layered-plate')}
    style={{ borderRadius: 22, padding: 22, ...style }}>
    {(label || actions) && (
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        {label && (
          <div>
            {typeof label === 'string'
              ? <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{label}</h3>
              : label}
          </div>
        )}
        {actions}
      </div>
    )}
    {children}
  </section>
);

// ——— Chip ———

type ChipTone = 'neutral' | 'gold' | 'green' | 'blue' | 'red' | 'dark';

type ChipProps = {
  children?: React.ReactNode;
  tone?: ChipTone;
  style?: React.CSSProperties;
};

export const Chip: React.FC<ChipProps> = ({ children, tone = 'neutral', style }) => {
  const tones: Record<ChipTone, { bg: string; fg: string; dot: string }> = {
    neutral: { bg: 'rgba(255, 248, 222, 0.6)',  fg: 'var(--ink-2)', dot: 'oklch(0.75 0.05 80)' },
    gold:    { bg: 'rgba(240, 200, 100, 0.22)', fg: '#6a4a10',       dot: 'oklch(0.75 0.15 78)' },
    green:   { bg: 'rgba(150, 200, 130, 0.22)', fg: '#3d5a22',       dot: 'oklch(0.68 0.14 140)' },
    blue:    { bg: 'rgba(130, 170, 220, 0.22)', fg: '#2a4a70',       dot: 'oklch(0.65 0.14 240)' },
    red:     { bg: 'rgba(220, 140, 120, 0.22)', fg: '#6a2a10',       dot: 'oklch(0.65 0.16 30)' },
    dark:    { bg: '#1d1608',                   fg: '#f9efd2',       dot: 'oklch(0.88 0.14 82)' },
  };
  const t = tones[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 8px 3px 7px', borderRadius: 999,
      background: t.bg, color: t.fg,
      fontSize: 11, fontWeight: 500, letterSpacing: '-0.005em',
      whiteSpace: 'nowrap',
      border: tone === 'dark' ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(180, 140, 60, 0.12)',
      ...style,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: t.dot }}/>
      {children}
    </span>
  );
};

// ——— Button ———

type BtnVariant = 'primary' | 'gold' | 'ghost' | 'bare';

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  icon?: React.FC<{ size?: number; style?: React.CSSProperties }>;
};

export const Btn: React.FC<BtnProps> = ({ children, variant = 'ghost', style, icon: Ic, ...rest }) => {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderRadius: 12,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    border: '1px solid transparent',
    fontFamily: 'inherit',
  };
  const variants: Record<BtnVariant, React.CSSProperties> = {
    primary: {
      background: 'linear-gradient(180deg, #2a1f08 0%, #1a1204 100%)',
      color: '#f9efd2',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 4px 10px -4px rgba(0,0,0,0.3)',
    },
    gold: {
      background: 'linear-gradient(180deg, oklch(0.88 0.13 82), oklch(0.72 0.14 62))',
      color: '#2a1f08',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.7), 0 4px 12px -4px rgba(200,150,50,0.5)',
    },
    ghost: {
      background: 'rgba(255, 248, 222, 0.4)',
      color: 'var(--ink)',
      border: '1px solid rgba(180, 140, 60, 0.18)',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6)',
    },
    bare: { background: 'transparent', color: 'var(--ink-2)' },
  };
  return (
    <button style={{ ...base, ...variants[variant], ...style }} {...rest}>
      {Ic && <Ic size={14}/>}
      {children}
    </button>
  );
};

// ——— Step label ———

export const StepLabel: React.FC<{ n: string; title: string }> = ({ n, title }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <span className="mono" style={{
      fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em',
      background: 'rgba(240, 200, 100, 0.15)',
      padding: '3px 8px', borderRadius: 6, fontWeight: 600,
    }}>{n}</span>
    <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</span>
  </div>
);

// ——— Field (label + input wrapper) ———

type FieldProps = {
  label: React.ReactNode;
  full?: boolean;
  children?: React.ReactNode;
};

export const Field: React.FC<FieldProps> = ({ label, full, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, gridColumn: full ? '1 / -1' : 'auto' }}>
    <div style={fieldLabel}>{label}</div>
    {children}
  </div>
);

// ——— SelectBox (glass dropdown) ———

type SelectBoxProps = {
  value: string;
  onChange: (v: string) => void;
  options: string[] | { value: string; label: string }[];
};

export const SelectBox: React.FC<SelectBoxProps> = ({ value, onChange, options }) => (
  <div className="etched" style={{
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px', borderRadius: 12, position: 'relative',
    cursor: 'pointer',
  }}>
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        flex: 1, border: 0, background: 'transparent', outline: 'none',
        appearance: 'none', padding: '2px 0', fontSize: 13, fontWeight: 500,
        color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit',
      }}>
      {(options as any[]).map(opt => {
        if (typeof opt === 'string') return <option key={opt} value={opt}>{opt}</option>;
        return <option key={opt.value} value={opt.value}>{opt.label}</option>;
      })}
    </select>
    <IconArrowDown size={12} style={{ color: 'var(--ink-3)' }}/>
  </div>
);

// ——— Toggle ———

type ToggleProps = {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
};

export const Toggle: React.FC<ToggleProps> = ({ on, onChange, disabled }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={() => !disabled && onChange(!on)}
    style={{
      position: 'relative', width: 44, height: 24, borderRadius: 999,
      background: on
        ? 'linear-gradient(180deg, oklch(0.88 0.13 82), oklch(0.72 0.14 62))'
        : 'rgba(180, 140, 60, 0.2)',
      boxShadow: on
        ? 'inset 0 1px 0 rgba(255,255,255,0.7), 0 0 0 2px rgba(240, 200, 100, 0.2)'
        : 'inset 0 1px 2px rgba(120,80,20,0.15)',
      border: 0, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'all 0.25s ease',
      fontFamily: 'inherit',
    }}>
    <span style={{
      position: 'absolute', top: 2, left: on ? 22 : 2,
      width: 20, height: 20, borderRadius: 999,
      background: on ? '#2a1f08' : 'white',
      transition: 'left 0.25s cubic-bezier(0.2, 0.9, 0.3, 1)',
      boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    }}/>
  </button>
);

// ——— SumRow (summary card line) ———

type SumRowProps = {
  label: React.ReactNode;
  v: React.ReactNode;
  highlight?: boolean;
};

export const SumRow: React.FC<SumRowProps> = ({ label, v, highlight }) => (
  <div style={{
    display: 'flex', justifyContent: 'space-between',
    color: highlight ? '#6a4a10' : 'var(--ink-3)',
  }}>
    <span style={{ fontSize: 12 }}>{label}</span>
    <span className="mono" style={{
      fontSize: 12,
      fontWeight: highlight ? 600 : 500,
      color: highlight ? 'var(--ink)' : 'var(--ink-2)',
    }}>{v}</span>
  </div>
);

// ——— Format helper (replaces window.fmt from prototype) ———

export const fmt = (n: number, { currency = false, decimals = 0 }: { currency?: boolean; decimals?: number } = {}) => {
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (n < 0 ? '−' : '') + (currency ? '$' + s : s);
};
// ─────────────────────────────────────────────────────────────
// Chart & Table primitives
// ─────────────────────────────────────────────────────────────

const smoothPath = (pts: [number, number][]): string => {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1], cur = pts[i];
    const mx = (prev[0] + cur[0]) / 2;
    d += ` C ${mx} ${prev[1]}, ${mx} ${cur[1]}, ${cur[0]} ${cur[1]}`;
  }
  return d;
};

export interface SeriesPoint { m: string; v: number; }

export interface StackedAreaChartProps {
  bottomSeries: SeriesPoint[];   // e.g. funded
  topSeries: SeriesPoint[];      // e.g. claimed — stacked ON TOP of bottom
  bottomLabel?: string;
  topLabel?: string;
  bottomAccent?: string;
  topAccent?: string;
  height?: number;
}

export const StackedAreaChart: React.FC<StackedAreaChartProps> = ({
  bottomSeries, topSeries,
  bottomAccent = 'oklch(0.72 0.14 62)',
  topAccent = 'oklch(0.82 0.13 148)',
  height = 180,
}) => {
  const n = Math.max(bottomSeries.length, topSeries.length);
  if (n < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-3)', fontSize: 12 }}>
        Not enough data yet — need at least 2 months of activity.
      </div>
    );
  }
  const w = 100, h = 40;
  const combined = Array.from({ length: n }).map((_, i) => ({
    m: bottomSeries[i]?.m ?? topSeries[i]?.m ?? '',
    b: bottomSeries[i]?.v ?? 0,
    t: topSeries[i]?.v ?? 0,
  }));
  const max = Math.max(1, ...combined.map(d => d.b + d.t));

  // Bottom layer points (from 0 → b)
  const bottomPts: [number, number][] = combined.map((d, i) => [(i / (n - 1)) * w, h - (d.b / max) * h]);
  const bottomPath = smoothPath(bottomPts);
  const bottomArea = `${bottomPath} L ${w} ${h} L 0 ${h} Z`;

  // Top layer points (stacked: from b → b+t)
  const topPts: [number, number][] = combined.map((d, i) => [(i / (n - 1)) * w, h - ((d.b + d.t) / max) * h]);
  const topPath = smoothPath(topPts);
  // top area goes from topPts line down to bottomPts line
  const topArea = `${topPath} L ${bottomPts[bottomPts.length - 1][0]} ${bottomPts[bottomPts.length - 1][1]} ${bottomPts.slice().reverse().map(p => `L ${p[0]} ${p[1]}`).join(' ')} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h + 10}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <defs>
        <linearGradient id="stackG-bottom" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={bottomAccent} stopOpacity="0.55"/>
          <stop offset="1" stopColor={bottomAccent} stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="stackG-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={topAccent} stopOpacity="0.5"/>
          <stop offset="1" stopColor={topAccent} stopOpacity="0"/>
        </linearGradient>
        <pattern id="stackGrid" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(180,140,60,0.08)" strokeWidth="0.2"/>
        </pattern>
      </defs>
      <rect x="0" y="0" width={w} height={h} fill="url(#stackGrid)"/>
      {/* bottom fill (funded) */}
      <path d={bottomArea} fill="url(#stackG-bottom)"/>
      <path d={bottomPath} fill="none" stroke={bottomAccent} strokeWidth="0.7" vectorEffect="non-scaling-stroke"/>
      {/* top fill (claimed stacked above funded) */}
      <path d={topArea} fill="url(#stackG-top)"/>
      <path d={topPath} fill="none" stroke={topAccent} strokeWidth="0.7" vectorEffect="non-scaling-stroke"/>
      {/* month labels */}
      {combined.map((d, i) => (
        <text key={'t' + i} x={(i / (n - 1)) * w} y={h + 7} fontSize="2.3" textAnchor="middle"
          fill="rgba(100, 80, 40, 0.6)" fontFamily="JetBrains Mono, monospace">{d.m}</text>
      ))}
    </svg>
  );
};

export interface LegendSwatchProps { color: string; label: string; dashed?: boolean; }
export const LegendSwatch: React.FC<LegendSwatchProps> = ({ color, label, dashed }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink-3)', fontSize: 11 }}>
    <span style={{
      width: 16, height: dashed ? 0 : 2,
      background: dashed ? 'transparent' : color,
      borderTop: dashed ? `1.5px dashed ${color}` : 'none',
    }}/>
    {label}
  </span>
);

export interface TableCol<T = any> {
  k: string;
  label: string;
  w?: string;
  align?: 'left' | 'right' | 'center';
  render?: (row: T) => React.ReactNode;
}
export interface TableProps<T = any> {
  cols: TableCol<T>[];
  rows: T[];
  onRow?: (row: T) => void;
  empty?: React.ReactNode;
  isRowActive?: (row: T) => boolean;
  maxHeight?: number;
}
export function Table<T = any>({ cols, rows, onRow, empty, isRowActive, maxHeight }: TableProps<T>) {
  const gridCols = cols.map(c => c.w || '1fr').join(' ');
  if (rows.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', fontSize: 13, color: 'var(--ink-3)' }}>
        {empty || 'No rows to display.'}
      </div>
    );
  }
  return (
    <div style={{
      width: '100%',
      ...(maxHeight ? { maxHeight, overflowY: 'auto' as const, overflowX: 'hidden' as const } : {}),
    }}>
      <div style={{
        display: 'grid', gridTemplateColumns: gridCols, padding: '10px 14px', gap: 12,
        fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
        color: 'var(--ink-3)', fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        borderBottom: '1px solid rgba(180,140,60,0.1)',
      }}>
        {cols.map(c => <div key={c.k} style={{ textAlign: c.align || 'left' }}>{c.label}</div>)}
      </div>
      {rows.map((r, i) => {
        const active = isRowActive?.(r) ?? false;
        return (
        <div key={i} onClick={() => onRow?.(r)}
          style={{
            display: 'grid', gridTemplateColumns: gridCols, padding: '12px 14px', gap: 12,
            alignItems: 'center', fontSize: 13,
            borderBottom: i === rows.length - 1 ? 'none' : '1px solid rgba(180,140,60,0.08)',
            cursor: onRow ? 'pointer' : 'default',
            transition: 'background 0.15s ease',
            background: active ? 'rgba(255, 248, 220, 0.85)' : 'transparent',
            borderLeft: active ? '3px solid oklch(0.72 0.15 62)' : '3px solid transparent',
            paddingLeft: active ? 11 : 14,
          }}
          onMouseEnter={!active && onRow ? (e) => { e.currentTarget.style.background = 'rgba(255, 248, 222, 0.45)'; } : undefined}
          onMouseLeave={!active && onRow ? (e) => { e.currentTarget.style.background = 'transparent'; } : undefined}>
          {cols.map(c => (
            <div key={c.k} style={{ textAlign: c.align || 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.render ? c.render(r) : (r as any)[c.k]}
            </div>
          ))}
        </div>
        );
      })}
    </div>
  );
}

// ————— Summary Tiles —————
// Row of 3-4 etched tiles for KPI summaries at the top of a report view.
// Used heavily in Accounting sub-tabs.
export interface SummaryTile {
  label: string;
  value: string;
  sub?: string;
  chip?: string;
  chipTone?: React.ComponentProps<typeof Chip>['tone'];
  valueColor?: string;
}
export interface SummaryTilesProps { tiles: SummaryTile[]; }

export const SummaryTiles: React.FC<SummaryTilesProps> = ({ tiles }) => (
  <div style={{
    display: 'grid',
    gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))`,
    gap: 12, marginBottom: 20,
  }}>
    {tiles.map((t, i) => (
      <div key={i} className="etched" style={{ padding: 14, borderRadius: 12 }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 8, gap: 8,
        }}>
          <div className="mono" style={{
            fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--ink-3)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {t.label}
          </div>
          {t.chip && <Chip tone={t.chipTone || 'neutral'}>{t.chip}</Chip>}
        </div>
        <div className="mono" style={{
          fontSize: 24, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1,
          color: t.valueColor || 'var(--ink)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {t.value}
        </div>
        {t.sub && (
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 8 }}>
            {t.sub}
          </div>
        )}
      </div>
    ))}
  </div>
);

// ————— Filter Bar —————
// Search input + filter chips. Sits between SummaryTiles and Table.
// Pass hideFilters when a search-only bar is wanted.
export interface FilterBarProps<T extends string = string> {
  query: string;
  setQuery: (q: string) => void;
  placeholder?: string;
  filter?: T;
  setFilter?: (f: T) => void;
  filters?: readonly T[];
  hideFilters?: boolean;
}

export function FilterBar<T extends string = string>({
  query, setQuery, placeholder = 'Search…',
  filter, setFilter, filters, hideFilters,
}: FilterBarProps<T>) {
  const list = filters ?? ([] as readonly T[]);
  return (
    <div style={{
      display: 'flex', gap: 12, alignItems: 'center',
      marginBottom: 16, flexWrap: 'wrap',
    }}>
      <div style={{ flex: '1 1 240px', minWidth: 180, maxWidth: 360 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={placeholder}
          style={{
            width: '100%',
            padding: '9px 14px',
            fontSize: 13,
            borderRadius: 10,
            border: '1px solid rgba(180, 140, 60, 0.2)',
            background: 'rgba(255, 248, 222, 0.5)',
            color: 'var(--ink)',
            outline: 'none',
            fontFamily: 'inherit',
            letterSpacing: '-0.01em',
          }}
        />
      </div>
      {!hideFilters && list.length > 0 && setFilter && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0, marginLeft: 'auto' }}>
          {list.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{
                padding: '7px 14px', borderRadius: 999, fontSize: 12, fontWeight: 500,
                cursor: 'pointer', whiteSpace: 'nowrap',
                border: '1px solid rgba(180, 140, 60, 0.2)',
                background: filter === f
                  ? 'linear-gradient(180deg, oklch(0.92 0.1 86), oklch(0.82 0.14 78))'
                  : 'rgba(255, 248, 222, 0.5)',
                color: filter === f ? '#1a1505' : 'var(--ink-2)',
                boxShadow: filter === f
                  ? 'inset 0 1px 0 rgba(255,255,255,0.6), 0 2px 6px -2px rgba(200,150,50,0.4)'
                  : 'none',
                transition: 'all 0.15s ease',
              }}>
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ————— Empty State —————
// Centered placeholder for empty tables / sections.
export interface EmptyProps { msg: string; }

export const Empty: React.FC<EmptyProps> = ({ msg }) => (
  <div className="etched" style={{
    padding: '36px 20px', borderRadius: 12, textAlign: 'center',
    color: 'var(--ink-3)', fontSize: 13, letterSpacing: '-0.005em',
  }}>
    {msg}
  </div>
);