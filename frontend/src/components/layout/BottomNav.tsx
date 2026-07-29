/**
 * BottomNav.tsx — Mobile bottom tab bar (shown only under 768px, see globals.css)
 *
 * Shows 4 most-used sections as always-visible tabs, plus a "Thêm" (More)
 * button that opens a slide-up sheet listing every other page from the
 * desktop Sidebar. Keeps a single source of truth for nav items by reusing
 * NAV_ITEMS / BOTTOM_ITEMS exported from Sidebar.tsx.
 */
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { MoreHorizontal, X } from 'lucide-react';
import { NAV_ITEMS, BOTTOM_ITEMS } from './Sidebar';

const PRIMARY_PATHS = ['/app', '/app/exams', '/app/upload', '/app/results'];

// Short labels for the narrow bottom tab bar (the desktop Sidebar labels
// are too long to fit 4-across on a phone screen).
const SHORT_LABEL: Record<string, string> = {
  '/app':         'Dashboard',
  '/app/exams':   'Kỳ thi',
  '/app/upload':  'Chấm phiếu',
  '/app/results': 'Kết quả',
};

export default function BottomNav() {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  const primaryItems = PRIMARY_PATHS
    .map(p => NAV_ITEMS.find(i => i.to === p))
    .filter((i): i is NonNullable<typeof i> => !!i)
    .map(i => ({ ...i, label: SHORT_LABEL[i.to] ?? i.label }));

  const moreItems = [
    ...NAV_ITEMS.filter(i => !PRIMARY_PATHS.includes(i.to)),
    ...BOTTOM_ITEMS,
  ];

  const isMoreActive = moreItems.some(i =>
    i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)
  );

  return (
    <>
      {moreOpen && (
        <div className="app-bottomnav-overlay" onClick={() => setMoreOpen(false)}>
          <div className="app-bottomnav-sheet" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 2px 14px' }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#1E1E1E' }}>Thêm</span>
              <button
                onClick={() => setMoreOpen(false)}
                style={{
                  border: 'none', background: '#F3F4F6', borderRadius: 8,
                  width: 30, height: 30, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', cursor: 'pointer',
                }}
              >
                <X size={16} color="#6B7280" />
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {moreItems.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setMoreOpen(false)}
                  style={({ isActive }) => ({
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    padding: '14px 6px', borderRadius: 12, textDecoration: 'none',
                    color: isActive ? '#C8102E' : '#374151',
                    background: isActive ? '#FEECEC' : '#F9FAFB',
                  })}
                >
                  {item.icon}
                  <span style={{ fontSize: 11, fontWeight: 600, textAlign: 'center', lineHeight: 1.25 }}>
                    {item.label}
                  </span>
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav className="app-bottom-nav">
        {primaryItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className="app-bottom-nav-item"
            style={({ isActive }) => ({ color: isActive ? '#C8102E' : '#9CA3AF' })}
          >
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className="app-bottom-nav-item"
          onClick={() => setMoreOpen(true)}
          style={{
            color: isMoreActive ? '#C8102E' : '#9CA3AF',
            background: 'none', border: 'none', fontFamily: 'inherit', cursor: 'pointer',
          }}
        >
          <MoreHorizontal size={20} />
          <span>Thêm</span>
        </button>
      </nav>
    </>
  );
}
