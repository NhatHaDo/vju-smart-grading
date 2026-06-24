import { useState } from 'react';
import { FileJson, Shield, User, ChevronRight } from 'lucide-react';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import { useAuth } from '../app/providers';

type Tab = 'template' | 'account' | 'security';

const TABS: { id: Tab; icon: React.ReactNode; label: string }[] = [
  { id: 'template', icon: <FileJson size={16} />, label: 'Template phiếu' },
  { id: 'account',  icon: <User     size={16} />, label: 'Tài khoản' },
  { id: 'security', icon: <Shield   size={16} />, label: 'Bảo mật' },
];

function TemplateTab() {
  const MOCK_TEMPLATES = [
    { id: 'vju_sbd8', name: 'VJU SBD 8 số', dimensions: '1000×1414', questions: 60, default: true },
    { id: 'vju_100q', name: 'VJU 100 câu',  dimensions: '2550×3301', questions: 100, default: false },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {MOCK_TEMPLATES.map(tpl => (
        <div key={tpl.id} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 16px', border: `1.5px solid ${tpl.default ? '#C8102E' : '#E5E7EB'}`, borderRadius: 12, background: tpl.default ? '#FEECEC' : '#fff' }}>
          <FileJson size={24} color={tpl.default ? '#C8102E' : '#9CA3AF'} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#1E1E1E' }}>{tpl.name}</div>
            <div style={{ fontSize: 12, color: '#6B7280' }}>
              {tpl.dimensions} · {tpl.questions} câu hỏi
            </div>
          </div>
          {tpl.default && (
            <span style={{ fontSize: 11, fontWeight: 700, color: '#C8102E', background: '#fff', border: '1px solid #C8102E', borderRadius: 99, padding: '2px 9px' }}>
              Mặc định
            </span>
          )}
          <ChevronRight size={16} color="#9CA3AF" />
        </div>
      ))}
      <Button variant="secondary" size="sm" style={{ alignSelf: 'flex-start', marginTop: 4 }}>
        + Thêm template
      </Button>
    </div>
  );
}

function AccountTab() {
  const { user } = useAuth();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#C8102E', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 22 }}>
          {(user?.name ?? 'GV').slice(0, 2).toUpperCase()}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#1E1E1E' }}>{user?.name ?? 'Giảng viên'}</div>
          <div style={{ fontSize: 13, color: '#6B7280' }}>{user?.email}</div>
          <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 2 }}>Vai trò: {user?.role ?? 'teacher'}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {[
          { label: 'Họ tên', value: user?.name ?? '', placeholder: 'Nguyễn Văn A' },
          { label: 'Email', value: user?.email ?? '', placeholder: 'teacher@vju.ac.vn' },
        ].map(f => (
          <div key={f.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>{f.label}</label>
            <input
              defaultValue={f.value}
              placeholder={f.placeholder}
              style={{ padding: '10px 14px', borderRadius: 10, border: '1.5px solid #E5E7EB', fontSize: 14, background: '#fafafa', color: '#1E1E1E', fontFamily: 'inherit', outline: 'none' }}
            />
          </div>
        ))}
      </div>

      <Button style={{ alignSelf: 'flex-start' }} onClick={() => alert('Phase 5: cập nhật API')}>
        Lưu thay đổi
      </Button>
    </div>
  );
}

function SecurityTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ padding: '14px 16px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, fontSize: 13, color: '#065F46' }}>
        ✅ Tài khoản được bảo vệ với JWT (access + refresh token)
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {['Mật khẩu hiện tại', 'Mật khẩu mới', 'Xác nhận mật khẩu mới'].map(label => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>{label}</label>
            <input
              type="password"
              placeholder="••••••••"
              style={{ padding: '10px 14px', borderRadius: 10, border: '1.5px solid #E5E7EB', fontSize: 14, background: '#fafafa', color: '#1E1E1E', fontFamily: 'inherit', outline: 'none' }}
            />
          </div>
        ))}
      </div>

      <Button style={{ alignSelf: 'flex-start' }} onClick={() => alert('Phase 6: đổi mật khẩu')}>
        Đổi mật khẩu
      </Button>

      <div style={{ borderTop: '1px solid #F3F4F6', paddingTop: 16 }}>
        <h4 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: '#374151' }}>Phiên đăng nhập</h4>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#6B7280' }}>
          JWT access token hết hạn sau 30 phút. Refresh token tự động gia hạn session.
        </p>
        <Button variant="danger" size="sm" onClick={() => alert('Phase 6: đăng xuất tất cả thiết bị')}>
          Đăng xuất tất cả thiết bị
        </Button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('template');

  const CONTENT: Record<Tab, React.ReactNode> = {
    template: <TemplateTab />,
    account:  <AccountTab />,
    security: <SecurityTab />,
  };

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      {/* Side tabs */}
      <Card style={{ width: 200, flexShrink: 0, padding: '8px 0' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              width: '100%', padding: '11px 16px',
              background: tab === t.id ? '#FEECEC' : 'none',
              border: 'none',
              borderRight: tab === t.id ? '3px solid #C8102E' : '3px solid transparent',
              color: tab === t.id ? '#C8102E' : '#6B7280',
              fontFamily: 'inherit', fontSize: 13, fontWeight: tab === t.id ? 700 : 400,
              cursor: 'pointer', textAlign: 'left',
              transition: 'background 140ms, color 140ms',
            }}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </Card>

      {/* Content */}
      <Card style={{ flex: 1 }}>
        <h2 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700, color: '#1E1E1E' }}>
          {TABS.find(t => t.id === tab)?.label}
        </h2>
        {CONTENT[tab]}
      </Card>
    </div>
  );
}
