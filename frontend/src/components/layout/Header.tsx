/**
 * Header.tsx — VJU red top bar
 * Logo: vju-logo-wide.png (ngang) — object-fit: contain, không crop
 */
import { useAuth } from '../../app/providers';

export default function Header() {
  const { user, logout } = useAuth();
  const initials = (user?.name ?? user?.email ?? 'GV').slice(0, 2).toUpperCase();

  return (
    <header style={{
      height: 64, background: '#C8102E',
      display: 'flex', alignItems: 'center',
      padding: '0 16px', gap: 12, flexShrink: 0,
      position: 'sticky', top: 0, zIndex: 100,
      boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
    }}>
      {/* Logo ngang — không crop, white trên nền đỏ */}
      <img
        src="/vju-logo-wide.png"
        alt="VJU"
        style={{
          height: 42, width: 'auto',
          objectFit: 'contain', display: 'block', flexShrink: 0,
          filter: 'brightness(0) invert(1)',
        }}
      />

      {/* Divider */}
      <div style={{ width: 1, height: 32, background: 'rgba(255,255,255,0.35)', flexShrink: 0 }} />

      {/* Title */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#fff', fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Hệ thống chấm phiếu thi trắc nghiệm tự động
        </div>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, letterSpacing: '0.05em' }}>
          VNU VIETNAM JAPAN UNIVERSITY
        </div>
      </div>

      {/* User */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ textAlign: 'right', lineHeight: 1.3 }}>
          <div style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}>{user?.name ?? 'Giảng viên'}</div>
          {user?.email && <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 10 }}>{user.email}</div>}
        </div>
        <div style={{
          width: 34, height: 34, borderRadius: '50%',
          background: 'rgba(255,255,255,0.22)',
          border: '2px solid rgba(255,255,255,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 800, fontSize: 13, flexShrink: 0,
        }}>{initials}</div>
        <button onClick={logout}
          style={{
            background: 'none', border: '1.5px solid rgba(255,255,255,0.55)',
            borderRadius: 9999, color: '#fff', padding: '5px 14px',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
            fontFamily: 'inherit', flexShrink: 0,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.15)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
        >Đăng xuất</button>
      </div>
    </header>
  );
}
