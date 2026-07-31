import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import type { User } from '../types/auth';
import { setAccessToken } from '../services/apiClient';

// 2026-07-31: "ủa sao chỗ kqua cũng có dữ liệu ở đâu ra vậy ?? acc t tạo mới,
// mới log in" — a brand-new account saw another teacher's graded batch. Root
// cause: several pages cache work-in-progress in plain (unscoped) browser
// localStorage — same key regardless of which account is logged in — as a
// fallback/offline layer (ResultsPage's "vju_last_batch_grade", AnswerKeyPage's
// drafts/library, ReviewErrorsPage's corrections, ...). On a shared browser,
// account B logging in after account A inherits A's cached data, entirely
// bypassing the server-side owner scoping fixed in /results earlier — this is
// a separate, client-only leak. Fix: wipe all of it whenever the logged-in
// user actually changes, and on logout (so a shared/public computer doesn't
// leave a teacher's answer keys sitting in the browser).
const USER_SCOPED_LS_KEYS = [
  'vju_last_batch_grade',        // ResultsPage / AnswerKeyPage / ReviewErrorsPage / analytics.ts
  'vju_pending_grade',           // ResultsPage
  'vju_answer_key',              // grading.ts — single "active" answer key
  'vju_answer_key_drafts',       // grading.ts — per-template drafts
  'vju_answer_key_library',      // grading.ts — saved answer-key library
  'vju_manual_corrections',      // grading.ts — manual correction store
  'vju_last_template',           // grading.ts — last-used template picker
  'vju_coord_picker_v3',         // TemplateCoordinatePage draft
];
const ACTIVE_USER_LS_KEY = 'vju_active_user_id';

function clearUserScopedLocalStorage() {
  for (const k of USER_SCOPED_LS_KEYS) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

interface AuthState {
  user:         User | null;
  accessToken:  string | null;
  refreshToken: string | null;
}

interface AuthContextValue extends AuthState {
  login:        (tokens: { accessToken: string; refreshToken: string; user: User }) => void;
  logout:       () => void;
  updateTokens: (accessToken: string, refreshToken: string) => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>(() => {
    try {
      const raw = sessionStorage.getItem('vju_auth');
      if (raw) {
        const parsed = JSON.parse(raw) as AuthState;
        setAccessToken(parsed.accessToken);
        return parsed;
      }
    } catch { /* ignore */ }
    return { user: null, accessToken: null, refreshToken: null };
  });

  const login = useCallback(
    (tokens: { accessToken: string; refreshToken: string; user: User }) => {
      // Different account than whatever was last active on this browser →
      // wipe the unscoped localStorage caches before showing this account
      // anything, so it never inherits a previous account's cached batch/
      // answer keys/corrections. Logging back in as the SAME account keeps
      // its own drafts intact.
      try {
        const prevUserId = localStorage.getItem(ACTIVE_USER_LS_KEY);
        const nextUserId = String(tokens.user.id);
        if (prevUserId !== nextUserId) {
          clearUserScopedLocalStorage();
          localStorage.setItem(ACTIVE_USER_LS_KEY, nextUserId);
        }
      } catch { /* ignore */ }

      const next: AuthState = {
        user:         tokens.user,
        accessToken:  tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
      setAccessToken(tokens.accessToken);
      sessionStorage.setItem('vju_auth', JSON.stringify(next));
      setAuth(next);
    },
    [],
  );

  const logout = useCallback(() => {
    setAccessToken(null);
    sessionStorage.removeItem('vju_auth');
    // Defense in depth for shared/public computers: don't leave any
    // teacher's cached batch/answer keys sitting in localStorage after
    // they've explicitly logged out.
    clearUserScopedLocalStorage();
    try { localStorage.removeItem(ACTIVE_USER_LS_KEY); } catch { /* ignore */ }
    setAuth({ user: null, accessToken: null, refreshToken: null });
  }, []);

  /**
   * Called after a silent token refresh: update tokens in state + sessionStorage
   * without touching the user object or navigating.
   */
  const updateTokens = useCallback((newAccessToken: string, newRefreshToken: string) => {
    setAccessToken(newAccessToken);
    setAuth(prev => {
      const next = { ...prev, accessToken: newAccessToken, refreshToken: newRefreshToken };
      try { sessionStorage.setItem('vju_auth', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  /**
   * Listen for the "vju-auth-expired" event dispatched by apiClient when a
   * refresh attempt fails. This clears the React auth state so:
   *  - <RequireAuth> redirects to /login
   *  - Header no longer shows user info
   */
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener('vju-auth-expired', handler);
    return () => window.removeEventListener('vju-auth-expired', handler);
  }, [logout]);

  return (
    <AuthContext.Provider
      value={{ ...auth, login, logout, updateTokens, isAuthenticated: !!auth.user }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
