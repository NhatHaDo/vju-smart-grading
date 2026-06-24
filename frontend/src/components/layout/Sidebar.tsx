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
  AlertTriangle,
  Key,
  FileText,
  ScanLine,
  Bug,
  TableProperties,
} from 'lucide-react';

interface NavItem {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/app',              icon: <LayoutGrid   size={20} />, label: 'Dashboard',           end: true },
  { to: '/app/exams',        icon: <BookOpen     size={20} />, label: 'Kỳ thi' },
  { to: '/app/upload',       icon: <Upload       size={20} />, label: 'Upload & Chấm' },
  { to: '/app/results',        icon: <BarChart2        size={20} />, label: 'Kết quả & Export' },
  { to: '/app/excel-preview', icon: <TableProperties  size={20} />, label: 'Xem trước Excel' },
  { to: '/app/analytics',     icon: <BarChart3        size={20} />, label: 'Thống kê & Phân tích' },
  { to: '/app/review-errors',icon: <AlertTriangle size={20} />, label: 'Kiểm tra lỗi' },
  { to: '/app/answer-key',   icon: <Key          size={20} />, label: 'Answer Key' },
  { to: '/app/templates',    icon: <FileText     size={20} />, label: 'Template phiếu' },
  { to: '/app/ocr-qr',       icon: <ScanLine     size={20} />, label: 'OCR/QR & Define Areas' },
];

const BOTTOM_ITEMS: NavItem[] = [
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
        {/* Group 1: Main */}
        <SidebarLink {...NAV_ITEMS[0]} />
        <SidebarLink {...NAV_ITEMS[1]} />
        <SidebarLink {...NAV_ITEMS[2]} />
        <Divider />
        {/* Group 2: Results */}
        <SidebarLink {...NAV_ITEMS[3]} />
        <SidebarLink {...NAV_ITEMS[4]} />
        <SidebarLink {...NAV_ITEMS[5]} />
        <SidebarLink {...NAV_ITEMS[6]} />
        <Divider />
        {/* Group 3: Config */}
        <SidebarLink {...NAV_ITEMS[7]} />
        <SidebarLink {...NAV_ITEMS[8]} />
        <SidebarLink {...NAV_ITEMS[9]} />
      </nav>

      <div style={{ paddingBottom: 8, borderTop: '1px solid #F0F0F0' }}>
        {BOTTOM_ITEMS.map(item => (
          <SidebarLink key={item.to} {...item} />
        ))}
      </div>
    </aside>
  );
}
