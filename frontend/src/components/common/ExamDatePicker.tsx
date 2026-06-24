/**
 * ExamDatePicker — custom calendar popup date picker.
 *
 * Props:
 *   value    — ISO date string "YYYY-MM-DD" or ""
 *   onChange — called with "YYYY-MM-DD" when user picks, or "" when cleared
 */
import { useEffect, useRef, useState } from 'react';
import { Calendar } from 'lucide-react';

// ── helpers ────────────────────────────────────────────────────────────────────

/** Parse "YYYY-MM-DD" → Date (local) or null */
function parseISO(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

/** Format Date → "dd/MM/yyyy" */
function fmtDisplay(dt: Date): string {
  const d = String(dt.getDate()).padStart(2, '0');
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const y = dt.getFullYear();
  return `${d}/${m}/${y}`;
}

/** Format Date → "YYYY-MM-DD" */
function fmtISO(dt: Date): string {
  const d = String(dt.getDate()).padStart(2, '0');
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${d}`;
}

/** Number of days in a month */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Day-of-week index Mon=0 … Sun=6 */
function weekdayMon(dt: Date): number {
  return (dt.getDay() + 6) % 7;
}

const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const MONTHS_VI = [
  'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4',
  'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8',
  'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
];

// ── styles (all inline, zero CSS deps) ────────────────────────────────────────

const S = {
  wrapper: {
    position: 'relative' as const,
    display: 'inline-block',
    width: '100%',
  },
  inputWrap: {
    display: 'flex',
    alignItems: 'center',
    borderRadius: 12,
    border: '1.5px solid #eee',
    background: '#fafafa',
    cursor: 'pointer',
    overflow: 'hidden',
  },
  inputText: {
    flex: 1,
    border: 'none',
    background: 'transparent',
    outline: 'none',
    padding: '10px 14px',
    fontSize: 14,
    color: '#1E1E1E',
    fontFamily: 'inherit',
    cursor: 'pointer',
    minWidth: 0,
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    padding: '0 12px 0 6px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    color: '#9CA3AF',
  },
  popup: {
    position: 'absolute' as const,
    top: 'calc(100% + 6px)',
    left: 0,
    zIndex: 9999,
    background: '#fff',
    borderRadius: 16,
    boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
    padding: '16px',
    minWidth: 280,
    userSelect: 'none' as const,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  navBtn: {
    background: '#F3F4F6',
    border: 'none',
    borderRadius: 8,
    width: 30,
    height: 30,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    color: '#374151',
    fontFamily: 'inherit',
  },
  monthLabel: {
    fontSize: 15,
    fontWeight: 700,
    color: '#1E1E1E',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: 2,
  },
  weekdayCell: {
    textAlign: 'center' as const,
    fontSize: 11,
    fontWeight: 700,
    color: '#9CA3AF',
    paddingBottom: 6,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTop: '1px solid #F3F4F6',
  },
  footerBtn: (primary: boolean) => ({
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    fontFamily: 'inherit',
    color: primary ? '#C8102E' : '#6B7280',
    padding: '4px 8px',
    borderRadius: 8,
  }),
};

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  value:    string;          // "YYYY-MM-DD" or ""
  onChange: (v: string) => void;
  disabled?: boolean;
}

export default function ExamDatePicker({ value, onChange, disabled }: Props) {
  const [open, setOpen]       = useState(false);
  const wrapRef               = useRef<HTMLDivElement>(null);

  // Calendar view state — month/year being shown
  const parsed = parseISO(value);
  const today  = new Date();
  const [viewYear,  setViewYear]  = useState(() => parsed?.getFullYear()  ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(() => parsed?.getMonth()     ?? today.getMonth());

  // Sync view to value when value changes externally
  useEffect(() => {
    const p = parseISO(value);
    if (p) { setViewYear(p.getFullYear()); setViewMonth(p.getMonth()); }
  }, [value]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // ── Calendar data ──
  const firstDay   = new Date(viewYear, viewMonth, 1);
  const totalDays  = daysInMonth(viewYear, viewMonth);
  const startPad   = weekdayMon(firstDay); // 0-6 blanks before day 1

  const cells: (number | null)[] = [
    ...Array(startPad).fill(null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];
  // Pad to full rows
  while (cells.length % 7 !== 0) cells.push(null);

  // ── Handlers ──
  const prevMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else                 { setViewMonth(m => m - 1); }
  };
  const nextMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else                  { setViewMonth(m => m + 1); }
  };
  const pickDay = (day: number) => {
    const dt = new Date(viewYear, viewMonth, day);
    onChange(fmtISO(dt));
    setOpen(false);
  };
  const clearDate = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setOpen(false);
  };
  const pickToday = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(fmtISO(today));
    setOpen(false);
  };

  const displayText = parsed ? fmtDisplay(parsed) : '';

  const isSelected = (day: number) =>
    parsed !== null &&
    parsed.getFullYear() === viewYear &&
    parsed.getMonth()    === viewMonth &&
    parsed.getDate()     === day;

  const isToday = (day: number) =>
    today.getFullYear() === viewYear &&
    today.getMonth()    === viewMonth &&
    today.getDate()     === day;

  return (
    <div ref={wrapRef} style={S.wrapper}>
      {/* Input trigger */}
      <div
        style={{
          ...S.inputWrap,
          borderColor: open ? '#C8102E' : '#eee',
          opacity: disabled ? 0.5 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
        }}
        onClick={() => !disabled && setOpen(o => !o)}
      >
        <input
          readOnly
          style={S.inputText}
          value={displayText}
          placeholder="dd/mm/yyyy"
        />
        <button
          type="button"
          style={S.iconBtn}
          tabIndex={-1}
          onClick={e => { e.stopPropagation(); if (!disabled) setOpen(o => !o); }}
        >
          <Calendar size={16} />
        </button>
      </div>

      {/* Popup */}
      {open && (
        <div style={S.popup} onMouseDown={e => e.stopPropagation()}>
          {/* Month navigation */}
          <div style={S.header}>
            <button type="button" style={S.navBtn} onClick={prevMonth}>‹</button>
            <span style={S.monthLabel}>
              {MONTHS_VI[viewMonth]} {viewYear}
            </span>
            <button type="button" style={S.navBtn} onClick={nextMonth}>›</button>
          </div>

          {/* Calendar grid */}
          <div style={S.grid}>
            {/* Weekday headers */}
            {WEEKDAYS.map(wd => (
              <div key={wd} style={S.weekdayCell}>{wd}</div>
            ))}

            {/* Day cells */}
            {cells.map((day, idx) => {
              if (day === null) return <div key={idx} />;

              const sel   = isSelected(day);
              const tod   = isToday(day) && !sel;
              const isSun = (idx % 7) === 6;

              const textColor = sel
                ? '#C8102E'
                : isSun ? '#EF4444'
                : tod    ? '#9B1C2E'
                : '#374151';

              return (
                <div
                  key={idx}
                  onClick={() => pickDay(day)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '2px 0',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => {
                    if (!sel) {
                      const inner = e.currentTarget.firstElementChild as HTMLElement;
                      if (inner) inner.style.background = '#F3F4F6';
                    }
                  }}
                  onMouseLeave={e => {
                    const inner = e.currentTarget.firstElementChild as HTMLElement;
                    if (inner) inner.style.background = sel ? '#FDECEF' : 'transparent';
                  }}
                >
                  {/* Inner circle — this is what gets the pill/circle bg */}
                  <div style={{
                    width: 34,
                    height: 34,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 9999,
                    fontSize: 13,
                    fontWeight: sel ? 600 : 400,
                    color: textColor,
                    background: sel ? '#FDECEF' : 'transparent',
                    boxShadow: 'none',
                    transition: 'background 0.1s',
                    userSelect: 'none',
                  }}>
                    {day}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div style={S.footer}>
            <button type="button" style={S.footerBtn(false)} onClick={clearDate}>Xoá</button>
            <button type="button" style={S.footerBtn(true)}  onClick={pickToday}>Hôm nay</button>
          </div>
        </div>
      )}
    </div>
  );
}
