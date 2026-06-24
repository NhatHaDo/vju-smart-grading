/**
 * LoginPage.tsx — VJU Smart Grading
 * Left: form | Right: FlowerCanvas decorative panel
 */
import { useState, useEffect, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../app/providers';
import { authApi } from '../services/apiClient';
import FlowerCanvas from '../components/decor/FlowerCanvas';
import type { User } from '../types/auth';

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, isAuthenticated } = useAuth();

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  // Show session-expired banner when redirected here by apiClient after refresh failure
  const [sessionExpired, setSessionExpired] = useState(() => {
    try {
      const flag = sessionStorage.getItem('vju_auth_expired');
      if (flag) { sessionStorage.removeItem('vju_auth_expired'); return true; }
    } catch { /* ignore */ }
    return false;
  });

  useEffect(() => {
    if (isAuthenticated) navigate('/app', { replace: true });
  }, [isAuthenticated, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(''); setSessionExpired(false);
    try {
      const result = await authApi.login(email, password);
      // Map backend snake_case → frontend camelCase
      const user: User = {
        id:        result.user.id,
        email:     result.user.email,
        name:      result.user.name,
        role:      result.user.role as User['role'],
        createdAt: result.user.created_at,
      };
      login({ accessToken: result.access_token, refreshToken: result.refresh_token, user });
      navigate('/app', { replace: true });
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Đăng nhập thất bại');
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

        {/* Back to home */}
        <button
          type="button"
          onClick={() => navigate('/')}
          style={{
            position: 'absolute', top: 20, left: 20,
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 13, color: '#9CA3AF', fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '6px 10px', borderRadius: 8,
            transition: 'color 150ms, background 150ms',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#C8102E'; (e.currentTarget as HTMLButtonElement).style.background = '#FEF2F2'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#9CA3AF'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
        >
          ← Về trang chủ
        </button>

        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 40 }}>
          {/* Logo tròn VJU seal */}
          <div style={{
            width: 54, height: 54, borderRadius: '50%',
            overflow: 'hidden', flexShrink: 0,
            border: '2px solid #f0f0f0',
            boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
          }}>
            <img src="/vju-seal.png" alt="VJU"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
          </div>
          <div style={{ width: 1.5, height: 44, background: '#e0e0e0', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: '#1B5E20', lineHeight: 1.2 }}>VJU</div>
            <div style={{ fontSize: 10.5, color: '#6B7280', lineHeight: 1.5 }}>
              Vietnam Japan University · VNU<br />since 1906
            </div>
          </div>
        </div>

        <h1 style={{ margin: '0 0 6px', fontSize: 26, fontWeight: 900, color: '#1E1E1E', letterSpacing: '-0.025em' }}>
          Xin chào 👋
        </h1>
        <p style={{ margin: '0 0 28px', fontSize: 13.5, color: '#6B7280', lineHeight: 1.55 }}>
          Đăng nhập để bắt đầu chấm phiếu trắc nghiệm
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Email */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>Email</label>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9CA3AF', pointerEvents: 'none', display: 'flex' }}>
                <Mail size={16} />
              </span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="teacher@vju.ac.vn" required
                style={{ width: '100%', boxSizing: 'border-box', borderRadius: 12, border: '1.5px solid #EBEBEB', padding: '11px 14px 11px 40px', fontSize: 14, background: '#fafafa', color: '#1E1E1E', fontFamily: 'inherit', outline: 'none' }}
                onFocus={e => { e.currentTarget.style.borderColor = '#C8102E'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(200,16,46,0.08)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = '#EBEBEB'; e.currentTarget.style.boxShadow = 'none'; }}
              />
            </div>
          </div>

          {/* Password */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>Mật khẩu</label>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9CA3AF', pointerEvents: 'none', display: 'flex' }}>
                <Lock size={16} />
              </span>
              <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Tối thiểu 6 ký tự" required
                style={{ width: '100%', boxSizing: 'border-box', borderRadius: 12, border: '1.5px solid #EBEBEB', padding: '11px 44px 11px 40px', fontSize: 14, background: '#fafafa', color: '#1E1E1E', fontFamily: 'inherit', outline: 'none' }}
                onFocus={e => { e.currentTarget.style.borderColor = '#C8102E'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(200,16,46,0.08)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = '#EBEBEB'; e.currentTarget.style.boxShadow = 'none'; }}
              />
              <button type="button" onClick={() => setShowPw(s => !s)}
                style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', display: 'flex', padding: 4 }}>
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {sessionExpired && !error && (
            <div style={{ padding: '10px 14px', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, color: '#92400E', fontSize: 13, fontWeight: 600 }}>
              ⏱ Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục.
            </div>
          )}

          {error && (
            <div style={{ padding: '10px 14px', background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 10, color: '#991B1B', fontSize: 13, fontWeight: 600 }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading}
            style={{ height: 48, borderRadius: 12, border: 'none', background: loading ? '#E5A0A0' : '#C8102E', color: '#fff', fontSize: 15, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginTop: 4, transition: 'transform 200ms, box-shadow 200ms' }}
            onMouseEnter={e => { if (!loading) { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 8px 22px rgba(200,16,46,0.38)'; } }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = ''; (e.currentTarget as HTMLButtonElement).style.boxShadow = ''; }}
          >{loading ? 'Đang xử lý…' : 'Đăng nhập'}</button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
            <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
            <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 600 }}>hoặc</span>
            <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
          </div>

          <button type="button" onClick={() => alert('Tính năng SSO VJU đang phát triển')}
            style={{ height: 46, borderRadius: 12, border: '1.5px solid #c8e6c9', background: '#f5faf5', color: '#1B5E20', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            Đăng nhập bằng tài khoản VJU
          </button>

          <p style={{ textAlign: 'center', fontSize: 12, color: '#9CA3AF', margin: 0 }}>
            Demo: <code>admin@vju.ac.vn</code> / <code>password</code>
          </p>
        </form>
      </div>

      {/* ── Right: flower canvas panel ── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Canvas full background with gradient + blobs + flowers */}
        <FlowerCanvas variant="auth" drawBg={true} />

        {/* Overlay content */}
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '0 48px',
        }}>
          {/* VJU seal in circle */}
          <div style={{
            width: 108, height: 108, borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)',
            border: '2px solid rgba(255,255,255,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 28, padding: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          }}>
            <img src="/vju-seal.png" alt="VJU"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
          </div>

          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.55)', marginBottom: 10, textTransform: 'uppercase', textAlign: 'center' }}>
            TRƯỜNG ĐẠI HỌC VIỆT NHẬT
          </div>
          <h2 style={{ margin: '0 0 14px', fontSize: 34, fontWeight: 900, color: '#fff', textAlign: 'center', letterSpacing: '-0.02em', textShadow: '0 2px 16px rgba(0,0,0,0.3)', lineHeight: 1.1 }}>
            Chào mừng đến VJU
          </h2>
          <p style={{ margin: '0 0 36px', fontSize: 15, color: 'rgba(255,255,255,0.62)', textAlign: 'center', lineHeight: 1.65, maxWidth: 360 }}>
            Hệ thống chấm phiếu thi trắc nghiệm tự động<br />
            dành riêng cho giảng viên VJU · Smart Grading
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ width: 26, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.88)' }} />
            <div style={{ width: 8,  height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.32)' }} />
            <div style={{ width: 8,  height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.32)' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
