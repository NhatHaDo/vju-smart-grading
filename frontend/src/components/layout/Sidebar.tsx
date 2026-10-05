/**
 * Sidebar.tsx — VJU style nav: icons only, opens up on hover
 *
 * 2026-10-05 (anh Tú): "cái menu e làm cái thu ra thu vào như này nè, nhìn như
 * hiện tại hơi khó" (Cổng đào tạo VJU) → "kiểu di chuột vào thì nó mở rộng
 * ra, hiện đủ hơn ấy". The 58px icon column keeps its place in the layout;
 * hovering (or tabbing into) it slides a wider panel out OVER the page with
 * every label and the group titles, and it folds back when the mouse leaves.
 * The page itself never shifts.
 */
import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutGrid,
  BookOpen,
  Upload,
  Zap,
  BarChart2,
  BarChart3,
  Key,
  Bug,
  TableProperties,
  Library,
  Shuffle,
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
  { to: '/app/question-bank', icon: <Library     size={20} />, label: 'Ngân hàng câu hỏi', group: 1 },
  { to: '/app/exam-papers',  icon: <Shuffle      size={20} />, label: 'Trộn đề', group: 1 },
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
  // 2026-09-30: "Template phiếu" + "Tạo Template Tọa Độ" hidden from the menu
  // (the shared Mẫu 40 template is now installed automatically). Routes
  // /app/templates and /app/template-coordinate still work for admins.
];

export const BOTTOM_ITEMS: NavItem[] = [
  { to: '/omr-debug', icon: <Bug size={20} />, label: 'OMR Debug' },
];

const COLLAPSED_W = 58;
const EXPANDED_W  = 236;

function SidebarLink({ to, icon, label, end, expanded }: NavItem & { expanded: boolean }) {
  const [hovered, setHovered] = useState(false);

  return (
    <NavLink
      to={to}
      end={end}
      title={expanded ? undefined : label}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 46,
        borderRadius: 12,
        margin: '3px 6px',
        padding: '0 13px',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        fontSize: 14,
        fontWeight: isActive ? 700 : 600,
        color: isActive || hovered ? '#C8102E' : expanded ? '#374151' : '#B0B8C4',
        background: isActive ? '#FEECEC' : hovered ? '#FEF2F2' : 'transparent',
        transition: 'background 150ms, color 150ms',
        boxShadow: isActive ? '0 1px 4px rgba(200,16,46,0.12)' : 'none',
      })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>
      <span style={{ opacity: expanded ? 1 : 0, transition: 'opacity 150ms' }}>{label}</span>
    </NavLink>
  );
}

function GroupTitle({ text, expanded }: { text: string; expanded: boolean }) {
  return (
    <div style={{ height: 1, background: '#F0F0F0', margin: '6px 12px', position: 'relative' }}>
      {expanded && (
        <span style={{ position: 'absolute', left: 8, top: -8, background: '#fff', padding: '0 6px', fontSize: 10.5,
          fontWeight: 700, letterSpacing: '0.06em', color: '#9CA3AF', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
          {text}
        </span>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { user } = useAuth();

  // 2026-08-07: lọc theo role TRƯỚC, rồi mới group theo field `group` (không
  // còn slice theo index — xem ghi chú trên NavItem.group giải thích lý do).
  const visibleItems = NAV_ITEMS.filter(item => !item.roles || (user && item.roles.includes(user.role)));
  const group1 = visibleItems.filter(item => item.group === 1);
  const group2 = visibleItems.filter(item => item.group === 2);
  const group3 = visibleItems.filter(item => item.group === 3);

  // open on hover after a short pause (a mouse merely crossing it to reach
  // the page doesn't flash the panel), close as soon as it leaves
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open  = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setExpanded(true), 120); };
  const close = () => { if (timer.current) clearTimeout(timer.current); setExpanded(false); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <aside
      className="app-sidebar"
      style={{ width: COLLAPSED_W, minHeight: '100%', flexShrink: 0, position: 'relative', zIndex: 40 }}
    >
      <div
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={() => setExpanded(true)}
        onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setExpanded(false); }}
        onClick={close}
        style={{
          position: 'absolute', top: 0, bottom: 0, left: 0,
          width: expanded ? EXPANDED_W : COLLAPSED_W,
          background: '#fff',
          borderRight: '1px solid #EBEBEB',
          boxShadow: expanded ? '6px 0 24px rgba(0,0,0,0.10)' : 'none',
          transition: 'width 180ms ease, box-shadow 180ms ease',
          display: 'flex',
          flexDirection: 'column',
          overflowX: 'hidden',
          overflowY: 'auto',
        }}
      >
        <nav style={{ flex: 1, paddingTop: 8, display: 'flex', flexDirection: 'column' }}>
          {group1.map(item => <SidebarLink key={item.to} {...item} expanded={expanded} />)}
          <GroupTitle text="Kết quả" expanded={expanded} />
          {group2.map(item => <SidebarLink key={item.to} {...item} expanded={expanded} />)}
          {group3.length > 0 && <GroupTitle text="Thiết lập" expanded={expanded} />}
          {group3.map(item => <SidebarLink key={item.to} {...item} expanded={expanded} />)}
        </nav>

        <div style={{ paddingBottom: 8, borderTop: '1px solid #F0F0F0' }}>
          {BOTTOM_ITEMS.map(item => (
            <SidebarLink key={item.to} {...item} expanded={expanded} />
          ))}
        </div>
      </div>
    </aside>
  );
}
