import { CSSProperties, ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
  onClick?: () => void;
}

export default function Card({ children, style, className, onClick }: CardProps) {
  return (
    <div
      className={className}
      onClick={onClick}
      style={{
        background: '#fff',
        borderRadius: 14,
        border: '1px solid #F1F3F5',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 14px rgba(0,0,0,0.04)',
        padding: '20px 22px',
        cursor: onClick ? 'pointer' : undefined,
        transition: onClick ? 'box-shadow 150ms, transform 150ms' : undefined,
        ...style,
      }}
      onMouseEnter={onClick ? e => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 20px rgba(0,0,0,0.10)';
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
      } : undefined}
      onMouseLeave={onClick ? e => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 1px 3px rgba(0,0,0,0.06), 0 4px 14px rgba(0,0,0,0.04)';
        (e.currentTarget as HTMLDivElement).style.transform = '';
      } : undefined}
    >
      {children}
    </div>
  );
}

/** Stat card with coloured accent bar */
interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
  icon?: ReactNode;
}

export function StatCard({ label, value, sub, accent = '#C8102E', icon }: StatCardProps) {
  return (
    <Card
      style={{
        borderTop: `3px solid ${accent}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </span>
        {icon && <span style={{ color: accent, opacity: 0.75 }}>{icon}</span>}
      </div>
      <div style={{ fontSize: 30, fontWeight: 800, color: '#1E1E1E', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#9CA3AF' }}>{sub}</div>}
    </Card>
  );
}
