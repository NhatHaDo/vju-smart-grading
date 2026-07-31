/**
 * Sidebar.tsx — Icon-only nav, VJU style
 */
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutGrid,
  BookOpen,
  Upload,
  BarChart2,
  BarChart3,
  Key,
  FileText,
  ScanLine,
  Bug,
  TableProperties,
} from 'lucide-react';

export interface NavItem {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/app',              icon: <LayoutGrid   size={20} />, label: 'Dashboard',           end: true },
  { to: '/app/exams',        icon: <BookOpen     size={20} />, label: 'Kỳ thi' },
  { to: '/app/upload',       icon: <Upload       size={20} />, label: 'Upload & Chấm' },
  { to: '/app/results',        icon: <BarChart2        size={20} />, label: 'Kết quả & Export' },
  { to: '/app/excel-preview', icon: <TableProperties  size={20} />, label: 'Xem trước Excel' },
  { to: '/app/analytics',     icon: <BarChart3        size={20} />, label: 'Thống kê & Phân tích' },
  // 2026-07-31: "cho giảng viên sửa trực tiếp luôn ở màn results; không cần
  // trang review-errors nữa" — ResultDetailModal (opened by clicking any row
  // on /app/results) already supports full inline editing, so this separate
  // nav destination was redundant. Route still exists (harmless if bookmarked)
  // but is no longer a first-class nav item.
  { to: '/app/answer-key',   icon: <Key          size={20} />, label: 'Answer Key' },
  { to: '/app/templates',    icon: <FileText     size={20} />, label: 'Template phiếu' },
  { to: '/app/template-coordinate', icon: <ScanLine size={20} />, label: 'Tạo Template Tọa Độ' },
];

export const BOTTOM_ITEMS: NavItem[] = [
  { to: '/omr-debug', icon: <Bug size={20} />, label: 'OMR Debug' },
];

function SidebarLink({ to, icon, label, end }: NavItem) {
  const [hovered, setHovered] = useState(false);

  return (
    <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
      <NavLink
        to={to}
        end={end}
        style={({ isActive }) => ({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 46,
          height: 46,
          borderRadius: 12,
          margin: '3px 6px',
          textDecoration: 'none',
          color: isActive ? '#C8102E' : hovered ? '#C8102E' : '#B0B8C4',
          background: isActive
            ? '#FEECEC'
            : hovered
            ? '#FEF2F2'
            : 'transparent',
          transition: 'background 150ms, color 150ms',
          boxShadow: isActive ? '0 1px 4px rgba(200,16,46,0.12)' : 'none',
        })}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {icon}
      </NavLink>

      {/* Tooltip */}
      {hovered && (
        <div
          style={{
            position: 'absolute',
            left: 'calc(100% + 8px)',
            top: '50%',
            transform: 'translateY(-50%)',
            background: '#1E1E1E',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            padding: '5px 10px',
            borderRadius: 6,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 200,
            boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
          }}
        >
          {label}
          <div style={{
            position: 'absolute',
            right: '100%',
            top: '50%',
            transform: 'translateY(-50%)',
            border: '5px solid transparent',
            borderRightColor: '#1E1E1E',
          }} />
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: '#F0F0F0', margin: '6px 12px' }} />;
}

export default function Sidebar() {
  return (
    <aside
      className="app-sidebar"
      style={{
        width: 58,
        minHeight: '100%',
        background: '#fff',
        borderRight: '1px solid #EBEBEB',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        zIndex: 40,
      }}
    >
      <nav style={{ flex: 1, paddingTop: 8, display: 'flex', flexDirection: 'column' }}>
        {/* 2026-07-31 fix: this used to render NAV_ITEMS[0..9] by hardcoded
           index. Removing the "Kiểm tra lỗi" entry shifted every later index
           down by one, which this hardcoded list never accounted for —
           "Answer Key" silently jumped into the wrong group, and the last
           line (NAV_ITEMS[9]) pointed past the end of the array, spreading
           `undefined` into <SidebarLink> (no icon, no `to`) — the empty pink
           box the user saw. Sliced by group instead, so this can't drift out
           of sync with NAV_ITEMS's length again. */}
        {/* Group 1: Main */}
        {NAV_ITEMS.slice(0, 3).map(item => <SidebarLink key={item.to} {...item} />)}
        <Divider />
        {/* Group 2: Results */}
        {NAV_ITEMS.slice(3, 6).map(item => <SidebarLink key={item.to} {...item} />)}
        <Divider />
        {/* Group 3: Config */}
        {NAV_ITEMS.slice(6).map(item => <SidebarLink key={item.to} {...item} />)}
      </nav>

      <div style={{ paddingBottom: 8, borderTop: '1px solid #F0F0F0' }}>
        {BOTTOM_ITEMS.map(item => (
          <SidebarLink key={item.to} {...item} />
        ))}
      </div>
    </aside>
  );
}
