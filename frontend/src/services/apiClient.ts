/**
 * Typed API client — wired to real backend endpoints.
 *
 * Auto-refresh flow:
 *   1. request() gets a 401/403 on a protected endpoint
 *   2. attemptRefresh() is called (shared promise → no parallel refresh storms)
 *   3. If refresh succeeds: update in-memory token + sessionStorage, retry once
 *   4. If refresh fails:    clear all auth, dispatch "vju-auth-expired", do NOT retry
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000';

// ── Typed API error ──────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Token storage (in-memory + sessionStorage fallback) ──────────────────────

let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Resolve the best available token:
 *   1. In-memory accessToken
 *   2. sessionStorage fallback (HMR reload, mount-order races, direct deep-links)
 */
export function resolveToken(): string | null {
  if (accessToken) return accessToken;
  try {
    const raw = sessionStorage.getItem('vju_auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { accessToken?: string };
    const t = parsed.accessToken ?? null;
    if (t) accessToken = t;
    return t;
  } catch {
    return null;
  }
}

export function hasToken(): boolean {
  return resolveToken() !== null;
}

// ── Refresh token logic ───────────────────────────────────────────────────────

/**
 * Shared promise: if multiple requests fail at the same time we only call
 * POST /auth/refresh once and all waiters share the result.
 */
let refreshPromise: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  try {
    const raw = sessionStorage.getItem('vju_auth');
    if (!raw) return null;

    const stored = JSON.parse(raw) as {
      accessToken?: string;
      refreshToken?: string;
      user?: unknown;
    };
    const rt = stored.refreshToken;
    if (!rt) return null;

    // Raw fetch — must NOT go through request() to avoid infinite loops
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refresh_token: rt }),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      access_token:  string;
      refresh_token: string;
      expires_in:    number;
    };

    // Update in-memory token
    accessToken = data.access_token;

    // Update sessionStorage (preserve user object)
    const updated = {
      ...stored,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
    };
    sessionStorage.setItem('vju_auth', JSON.stringify(updated));

    return data.access_token;
  } catch {
    return null;
  }
}

/** Attempt a token refresh. Deduplicated: concurrent callers share one promise. */
async function attemptRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/**
 * Hard-logout: clear memory + storage and notify listeners.
 * Debounced so concurrent 401s only fire one event.
 */
let authExpiredFired = false;
function dispatchAuthExpired() {
  if (authExpiredFired) return;
  authExpiredFired = true;
  setTimeout(() => { authExpiredFired = false; }, 200);

  accessToken = null;
  try {
    sessionStorage.setItem('vju_auth_expired', '1');
    sessionStorage.removeItem('vju_auth');
  } catch { /* ignore */ }

  window.dispatchEvent(new Event('vju-auth-expired'));
}

// ── Paths that must never trigger a refresh attempt ─────────────────────────

function isAuthPath(path: string): boolean {
  return path.includes('/auth/login') || path.includes('/auth/refresh');
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────

/**
 * Low-level fetch with auto-refresh + retry.
 * Unlike request(), does NOT force-set Content-Type — suitable for
 * FormData uploads where the browser must set multipart/form-data boundaries.
 * Returns the raw Response so the caller can parse it however they need.
 */
export async function requestRaw(
  path: string,
  options: RequestInit = {},
  _isRetry = false,
): Promise<Response> {
  const token = resolveToken();
  const hdrs = new Headers(options.headers as HeadersInit | undefined);
  if (token) hdrs.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers: hdrs });

  if ((res.status === 401 || res.status === 403) && !_isRetry && !isAuthPath(path)) {
    const newToken = await attemptRefresh();
    if (newToken) return requestRaw(path, options, true);
    dispatchAuthExpired();
  }

  return res;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  _isRetry = false,
): Promise<T> {
  const token = resolveToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    let msg = (body as { detail?: string }).detail ?? res.statusText;

    if (res.status === 401 || res.status === 403) {
      if (msg === 'Not authenticated' || msg === 'Không thể xác thực token') {
        msg = 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại';
      }

      if (!_isRetry && !isAuthPath(path)) {
        const newToken = await attemptRefresh();
        if (newToken) {
          // Retry the original request exactly once with the fresh token
          return request<T>(path, options, true);
        }
        // Refresh failed → hard logout
        dispatchAuthExpired();
      }
    }

    throw new ApiError(res.status, msg);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    request<{
      access_token:  string;
      refresh_token: string;
      token_type:    string;
      expires_in:    number;
      user: {
        id: number; email: string; name: string; role: string;
        is_active: boolean; created_at: string;
      };
    }>(
      '/api/v1/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
    ),

  register: (email: string, password: string, name: string) =>
    request('/api/v1/auth/register', {
      method: 'POST',
      body:   JSON.stringify({ email, password, name }),
    }),

  me: () => request('/api/v1/auth/me'),

  logout: (refreshToken: string) =>
    request('/api/v1/auth/logout', {
      method: 'POST',
      body:   JSON.stringify({ refresh_token: refreshToken }),
    }),
};

// ── Exams ─────────────────────────────────────────────────────────────────────

import type { ExamOut, ExamCreatePayload } from '../types/exam';

export const examsApi = {
  list:   ()                              => request<ExamOut[]>('/api/v1/exams'),
  get:    (id: number)                    => request<ExamOut>(`/api/v1/exams/${id}`),
  create: (payload: ExamCreatePayload)    => request<ExamOut>('/api/v1/exams', { method: 'POST', body: JSON.stringify(payload) }),
  update: (id: number, payload: ExamCreatePayload) => request<ExamOut>(`/api/v1/exams/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  delete: (id: number)                    => request<void>(`/api/v1/exams/${id}`, { method: 'DELETE' }),
};

// ── Grading ───────────────────────────────────────────────────────────────────

export const gradingApi = {
  upload: (examId: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch(`${API_BASE}/api/v1/exams/${examId}/grade`, {
      method:  'POST',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      body:    fd,
    }).then(r => r.json());
  },
  jobStatus: (jobId: string) => request(`/api/v1/jobs/${jobId}`),
  results:   (examId: number) => request(`/api/v1/exams/${examId}/results`),
};

// ── Results (batch persist) ───────────────────────────────────────────────────

export interface BatchResultOut {
  id:                      number;
  exam_id:                 number | null;
  sheet_id:                number | null;
  template_type:           string | null;
  template_variant:        string | null;
  template_id:             number | null;
  file_name:               string | null;
  cccd:                    string | null;
  sbd:                     string | null;
  ma_de:                   string | null;
  ca_thi:                  string | null;
  answers_json:            string;
  scores_json:             string;
  section_json:            string;
  total_score:             number;
  severity:                string;
  needs_review:            boolean;
  empty_count:             number;
  multi_mark_count:        number;
  warnings_json:           string | null;
  info_field_columns_json: string | null;
  debug_paths_json:        string | null;
  manual_corrections_json: string | null;
  graded_at:               string;
  corrected_at:            string | null;
}

export interface ResultListOut {
  total: number;
  items: BatchResultOut[];
}

export interface ResultBatchSaveItem {
  file_name:          string;
  template_type?:     string | null;
  template_variant?:  string | null;
  template_id?:       number | null;
  exam_id?:           number | null;
  cccd?:              string | null;
  sbd?:               string | null;
  ma_de?:             string | null;
  ca_thi?:            string | null;
  answers?:           Record<string, unknown>;
  scores?:            Record<string, unknown>;
  sections?:          Record<string, unknown>;
  total_score?:       number;
  severity?:          string;
  needs_review?:      boolean;
  empty_count?:       number;
  multi_mark_count?:  number;
  warnings?:          unknown;
  info_field_columns?:unknown;
  debug_paths?:       unknown;
}

export interface ResultBatchSaveRequest {
  template_type?:    string | null;
  template_variant?: string | null;
  template_id?:      number | null;
  exam_id?:          number | null;
  graded_at?:        string | null;
  items:             ResultBatchSaveItem[];
}

export interface ResultBatchSaveResponse {
  saved: number;
  ids:   number[];
}

export const resultsApi = {
  list: (params?: { exam_id?: number; template_type?: string; needs_review?: boolean; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.exam_id      != null) q.set('exam_id',       String(params.exam_id));
    if (params?.template_type       ) q.set('template_type', params.template_type);
    if (params?.needs_review != null) q.set('needs_review',  String(params.needs_review));
    if (params?.limit        != null) q.set('limit',         String(params.limit));
    const qs = q.toString();
    return request<ResultListOut>(`/api/v1/results${qs ? '?' + qs : ''}`);
  },

  getById: (id: number) =>
    request<BatchResultOut>(`/api/v1/results/${id}`),

  saveBatch: (payload: ResultBatchSaveRequest) =>
    request<ResultBatchSaveResponse>('/api/v1/results/batch', {
      method: 'POST',
      body:   JSON.stringify(payload),
    }),

  deleteOne: (id: number) =>
    request<void>(`/api/v1/results/${id}`, { method: 'DELETE' }),

  deleteAll: (params?: { exam_id?: number }) => {
    const q = new URLSearchParams();
    if (params?.exam_id != null) q.set('exam_id', String(params.exam_id));
    const qs = q.toString();
    return request<{ deleted: number }>(`/api/v1/results${qs ? '?' + qs : ''}`, { method: 'DELETE' });
  },

  saveCorrection: (id: number, payload: {
    corrected_answers?:      Record<string, string>;
    corrected_student_info?: Record<string, string>;
    notes?:                  string;
    mark_as_reviewed?:       boolean;
  }) =>
    request<BatchResultOut>(`/api/v1/results/${id}/correction`, {
      method: 'PUT',
      body:   JSON.stringify(payload),
    }),
};

// ── Custom Forms (templates) ──────────────────────────────────────────────────

export interface CustomFormMeta {
  id:          number;
  name:        string;
  type:        string;
  area_count:  number;
  page_width:  number | null;
  page_height: number | null;
  is_active?:  boolean;
  is_default:  boolean;
  created_at?: string;
  updated_at:  string;
}

export const customFormsApi = {
  list: () =>
    request<{ forms: CustomFormMeta[] }>('/api/v1/custom-forms'),

  get: (id: number) =>
    request<{ areas: unknown[] }>(`/api/v1/custom-forms/${id}`),

  rename: (id: number, name: string) =>
    request<CustomFormMeta>(`/api/v1/custom-forms/${id}/rename`, {
      method: 'PUT',
      body:   JSON.stringify({ name }),
    }),

  delete: (id: number) =>
    request<void>(`/api/v1/custom-forms/${id}`, { method: 'DELETE' }),

  duplicate: (id: number) =>
    request<CustomFormMeta>(`/api/v1/custom-forms/${id}/duplicate`, { method: 'POST' }),
};

// ── Health ────────────────────────────────────────────────────────────────────

export const healthApi = {
  check: () => request<{ status: string; timestamp: string }>('/api/v1/health'),
};

export default request;
