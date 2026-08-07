/**
 * Sidebar.tsx — Icon-only nav, VJU style
 */
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutGrid,
  BookOpen,
  Upload,
  Zap,
  BarChart2,
  BarChart3,
  Key,
  FileText,
  ScanLine,
  Bug,
  TableProperties,
} from 'lucide-react';
import { useAuth } from '../../app/providers';
import type { Role } from '../../types/auth';

export interface NavItem {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
  /** 2026-08-07: "t muốn 2 chức năng này chỉ có tài khoản admin có" — nếu set,
   *  mục này chỉ hiện cho user có role nằm trong danh sách. Không set = hiện
   *  cho mọi role đã đăng nhập (hành vi cũ). group giữ nguyên vị trí hiển thị
   *  (1=Main, 2=Results, 3=Config) — tách riêng khỏi index mảng để lọc theo
   *  role không làm lệch group như bug slice-theo-index đã gặp trước đây. */
  roles?: Role[];
  /** Chỉ dùng để group NAV_ITEMS khi render (xem Sidebar() bên dưới) —
   *  không bắt buộc, BOTTOM_ITEMS không cần field này. */
  group?: 1 | 2 | 3;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/app',              icon: <LayoutGrid   size={20} />, label: 'Dashboard',           end: true, group: 1 },
  { to: '/app/exams',        icon: <BookOpen     size={20} />, label: 'Kỳ thi', group: 1 },
  { to: '/app/upload',       icon: <Upload       size={20} />, label: 'Upload & Chấm', group: 1 },
  { to: '/app/quick-grade',  icon: <Zap          size={20} />, label: 'Chấm nhanh', group: 1 },
  { to: '/app/results',        icon: <BarChart2        size={20} />, label: 'Kết quả & Export', group: 2 },
  { to: '/app/excel-preview', icon: <TableProperties  size={20} />, label: 'Xem trước Excel', group: 2 },
  { to: '/app/analytics',     icon: <BarChart3        size={20} />, label: 'Thống kê & Phân tích', group: 2 },
  // 2026-07-31: "cho giảng viên sửa trực tiếp luôn ở màn results; không cần
  // trang review-errors nữa" — ResultDetailModal (opened by clicking any row
  // on /app/results) already supports full inline editing, so this separate
  // nav destination was redundant. Route still exists (harmless if bookmarked)
  // but is no longer a first-class nav item.
  { to: '/app/answer-key',   icon: <Key          size={20} />, label: 'Answer Key', group: 3 },
  { to: '/app/templates',    icon: <FileText     size={20} />, label: 'Template phiếu', group: 3, roles: ['admin'] },
  { to: '/app/template-coordinate', icon: <ScanLine size={20} />, label: 'Tạo Template Tọa Độ', group: 3, roles: ['admin'] },
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
  const { user } = useAuth();

  // 2026-08-07: lọc theo role TRƯỚC, rồi mới group theo field `group` (không
  // còn slice theo index — xem ghi chú trên NavItem.group giải thích lý do).
  const visibleItems = NAV_ITEMS.filter(item => !item.roles || (user && item.roles.includes(user.role)));
  const group1 = visibleItems.filter(item => item.group === 1);
  const group2 = visibleItems.filter(item => item.group === 2);
  const group3 = visibleItems.filter(item => item.group === 3);

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
        {group1.map(item => <SidebarLink key={item.to} {...item} />)}
        <Divider />
        {group2.map(item => <SidebarLink key={item.to} {...item} />)}
        {group3.length > 0 && <Divider />}
        {group3.map(item => <SidebarLink key={item.to} {...item} />)}
      </nav>

      <div style={{ paddingBottom: 8, borderTop: '1px solid #F0F0F0' }}>
        {BOTTOM_ITEMS.map(item => (
          <SidebarLink key={item.to} {...item} />
        ))}
      </div>
    </aside>
  );
}
