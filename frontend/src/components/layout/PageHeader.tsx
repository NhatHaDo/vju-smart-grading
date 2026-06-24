/**
 * PageHeader — white title bar at top of each page.
 * Renders: bold page title + gray subtitle.
 */
import { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export default function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div
      style={{
        background: '#fff',
        borderBottom: '1px solid #E5E7EB',
        padding: '18px 28px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        flexShrink: 0,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1E1E1E', lineHeight: 1.25 }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ margin: '3px 0 0', fontSize: 13, color: '#6B7280' }}>{subtitle}</p>
        )}
      </div>
      {actions && <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}
