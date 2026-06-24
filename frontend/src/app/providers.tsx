import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import type { User } from '../types/auth';
import { setAccessToken } from '../services/apiClient';

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
