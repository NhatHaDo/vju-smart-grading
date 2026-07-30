/**
 * ForgotPasswordPage.tsx — VJU Smart Grading
 * Reset-by-match: entering the account's own email + phone number is
 * treated as proof of ownership and immediately lets the user set a new
 * password — no OTP/email-link step, per explicit product choice
 * ("chỉ cần nhập đúng gmail và sđt là cho người ta đặt mật khẩu mới").
 */
import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Phone, Lock, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { authApi } from '../services/apiClient';
import FlowerCanvas from '../components/decor/FlowerCanvas';

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', borderRadius: 12, border: '1.5px solid #EBEBEB',
  padding: '11px 14px 11px 40px', fontSize: 14, background: '#fafafa', color: '#1E1E1E',
  fontFamily: 'inherit', outline: 'none',
};
function focusRing(e: React.FocusEvent<HTMLInputElement>) { e.currentTarget.style.borderColor = '#C8102E'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(200,16,46,0.08)'; }
function blurRing(e: React.FocusEvent<HTMLInputElement>)  { e.currentTarget.style.borderColor = '#EBEBEB'; e.currentTarget.style.boxShadow = 'none'; }

export default function ForgotPasswordPage() {
  const navigate = useNavigate();

  const [email,       setEmail]       = useState('');
  const [phone,        setPhone]      = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPw,       setShowPw]     = useState(false);
  const [loading,      setLoading]    = useState(false);
  const [error,        setError]      = useState('');
  const [done,         setDone]       = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await authApi.resetPassword(email.trim(), phone.trim(), newPassword);
      setDone(true);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Không đặt lại được mật khẩu — kiểm tra lại email và số điện thoại');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: '"Be Vietnam Pro","Segoe UI",sans-serif' }}>

      {/* ── Left: form panel ── */}
      <div style={{
        width: 420, flexShrink: 0, background: '#fff',
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        padding: '48px 40px', boxShadow: '4px 0 28px rgba(0,0,0,0.10)',
        position: 'relative', zIndex: 10,
      }}>

        <button
          type="button"
          onClick={() => navigate('/login')}
          style={{ position: 'absolute', top: 20, left: 20, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#9CA3AF', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 8 }}
        >
          ← Quay lại đăng nhập
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 32, marginTop: 12 }}>
          <div style={{ width: 54, height: 54, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, border: '2px solid #f0f0f0', boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
            <img src="/vju-seal.png" alt="VJU" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
          </div>
          <div style={{ width: 1.5, height: 44, background: '#e0e0e0', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: '#1B5E20', lineHeight: 1.2 }}>VJU</div>
            <div style={{ fontSize: 10.5, color: '#6B7280', lineHeight: 1.5 }}>Vietnam Japan University · VNU<br />since 1906</div>
          </div>
        </div>

        {done ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <CheckCircle2 size={28} color="#10B981" />
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: '#1E1E1E' }}>Đã đặt lại mật khẩu!</h1>
            </div>
            <p style={{ fontSize: 13.5, color: '#6B7280', lineHeight: 1.6, marginBottom: 24 }}>
              Mật khẩu mới cho <strong style={{ color: '#1E1E1E' }}>{email}</strong> đã có hiệu lực — đăng nhập lại ngay.
            </p>
            <button type="button" onClick={() => navigate('/login')}
              style={{ width: '100%', height: 48, borderRadius: 12, border: 'none', background: '#C8102E', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              Đăng nhập ngay →
            </button>
          </div>
        ) : (
          <>
            <h1 style={{ margin: '0 0 6px', fontSize: 24, fontWeight: 900, color: '#1E1E1E', letterSpacing: '-0.025em' }}>
              Quên mật khẩu?
            </h1>
            <p style={{ margin: '0 0 26px', fontSize: 13.5, color: '#6B7280', lineHeight: 1.55 }}>
              Nhập đúng email và số điện thoại đã đăng ký để đặt mật khẩu mới ngay.
            </p>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>Email</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9CA3AF', pointerEvents: 'none', display: 'flex' }}><Mail size={16} /></span>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="giangvien@vju.ac.vn" required
                    style={inputStyle} onFocus={focusRing} onBlur={blurRing} />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>Số điện thoại đã đăng ký</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9CA3AF', pointerEvents: 'none', display: 'flex' }}><Phone size={16} /></span>
                  <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="09xxxxxxxx" required
                    style={inputStyle} onFocus={focusRing} onBlur={blurRing} />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>Mật khẩu mới</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9CA3AF', pointerEvents: 'none', display: 'flex' }}><Lock size={16} /></span>
                  <input type={showPw ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Tối thiểu 6 ký tự" required minLength={6}
                    style={{ ...inputStyle, padding: '11px 44px 11px 40px' }} onFocus={focusRing} onBlur={blurRing} />
                  <button type="button" onClick={() => setShowPw(s => !s)}
                    style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', display: 'flex', padding: 4 }}>
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {error && (
                <div style={{ padding: '10px 14px', background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 10, color: '#991B1B', fontSize: 13, fontWeight: 600 }}>
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading}
                style={{ height: 48, borderRadius: 12, border: 'none', background: loading ? '#E5A0A0' : '#C8102E', color: '#fff', fontSize: 15, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginTop: 4 }}>
                {loading ? 'Đang xử lý…' : 'Đặt lại mật khẩu'}
              </button>
            </form>
          </>
        )}
      </div>

      {/* ── Right: flower canvas panel ── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <FlowerCanvas variant="auth" drawBg={true} />
        <div style={{ position: 'absolute', inset: 0, zIndex: 5, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 48px' }}>
          <div style={{ width: 108, height: 108, borderRadius: '50%', background: 'rgba(255,255,255,0.15)', border: '2px solid rgba(255,255,255,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 28, padding: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }}>
            <img src="/vju-seal.png" alt="VJU" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.55)', marginBottom: 10, textTransform: 'uppercase', textAlign: 'center' }}>
            TRƯỜNG ĐẠI HỌC VIỆT NHẬT
          </div>
          <h2 style={{ margin: '0 0 14px', fontSize: 30, fontWeight: 900, color: '#fff', textAlign: 'center', letterSpacing: '-0.02em', textShadow: '0 2px 16px rgba(0,0,0,0.3)', lineHeight: 1.2 }}>
            Lấy lại quyền truy cập
          </h2>
          <p style={{ margin: 0, fontSize: 15, color: 'rgba(255,255,255,0.62)', textAlign: 'center', lineHeight: 1.65, maxWidth: 360 }}>
            Xác nhận đúng email và số điện thoại<br />để đặt mật khẩu mới ngay lập tức
          </p>
        </div>
      </div>
    </div>
  );
}
