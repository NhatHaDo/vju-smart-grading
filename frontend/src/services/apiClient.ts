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

/** A question's formula / picture ("[[ct:<id>]]" in its text) as an image URL. */
export const questionAssetUrl = (id: string) => `${API_BASE}/api/v1/question-bank/assets/${id}.svg`;

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
  return path.includes('/auth/login') || path.includes('/auth/refresh')
    || path.includes('/auth/register') || path.includes('/auth/reset-password');
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

  register: (email: string, password: string, phone: string, name: string) =>
    request('/api/v1/auth/register', {
      method: 'POST',
      body:   JSON.stringify({ email, password, phone, name }),
    }),

  /** Reset-by-match: matching email + phone sets a new password directly —
   *  no OTP/email-link step, per explicit product choice. */
  resetPassword: (email: string, phone: string, newPassword: string) =>
    request('/api/v1/auth/reset-password', {
      method: 'POST',
      body:   JSON.stringify({ email, phone, new_password: newPassword }),
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
  ma_ctdt?:                string | null;
  tu_chon?:                string | null;
  info_values?:            Record<string, string | null> | null;
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
  signatures_json?:        string | null;
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
  ma_ctdt?:           string | null;
  tu_chon?:           string | null;
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
  signatures?:        unknown;
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

/** Shape returned by GET /api/v1/custom-forms/{id} */
export interface CustomFormDetail {
  id:           number;
  name:         string;
  page_width:   number | null;
  page_height:  number | null;
  areas:        unknown[];
  template:     unknown;
  /** MCQ answer fields (includeInAnswerKey === true) */
  answerFields: {
    key:        string;
    label:      string;
    blockName:  string;
    /** User-given display name for the whole block (e.g. "TN1") — used as the section header. */
    blockLabel?: string;
    options:    string[];
    composite?: boolean;
    sourceFields?: string[];
    /** e.g. "decimal" for signed-decimal composite fields — drives text-input rendering. */
    inputType?: string;
  }[];
  /** INT info fields (includeInAnswerKey === false) */
  infoFields: {
    key:         string;
    displayName: string;
    fieldType:   string;
  }[];
  updated_at:  string;
}

export const customFormsApi = {
  /** DB ids of the shared "pinned" templates — they differ per database. */
  pinned: () =>
    request<{ mau40: number | null; bgd?: number | null }>('/api/v1/custom-forms/pinned'),

  list: () =>
    request<{ forms: CustomFormMeta[] }>('/api/v1/custom-forms'),

  get: (id: number) =>
    request<CustomFormDetail>(`/api/v1/custom-forms/${id}`),

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

// ── Ngân hàng câu hỏi ─────────────────────────────────────────────────────────

export interface QuestionCategoryOut {
  id:             number;
  name:           string;
  description:    string | null;
  owner_id:       number;
  owner_name:     string;
  /** owner = mine (or admin); edit/view = shared with me */
  access:         'owner' | 'edit' | 'view';
  question_count: number;
  type_counts:    Record<QuestionType, number>;
  /** trắc nghiệm questions with no answer yet (imported from a file that doesn't mark it) */
  unanswered:     number;
  created_at:     string;
  updated_at:     string;
}

/** mcq = trắc nghiệm (Phần I-II trên phiếu), tf = Đúng/Sai (Phần III, 4 ý), short = trả lời ngắn (Phần IV) */
export type QuestionType = 'mcq' | 'tf' | 'short';

export interface QuestionOption {
  text:     string;
  /** YoungMix "#A." — keeps its position when options are shuffled. */
  fixed:    boolean;
  /** Đúng/Sai statements only: is this statement true? */
  correct?: boolean | null;
}

export interface QuestionPayload {
  qtype:           QuestionType;
  content:         string;
  options:         QuestionOption[];
  /** mcq: index of the correct option (0 = A). */
  answer:          number;
  /** short: the number as bubbled on the sheet, e.g. "-1,5". */
  answer_text?:    string | null;
  shuffle_options: boolean;
}

export interface QuestionOut extends QuestionPayload {
  id:          number;
  category_id: number;
  created_at:  string;
  updated_at:  string;
}

export interface QuestionImportResult {
  dry_run:    boolean;
  found:      number;
  new:        number;
  duplicates: number;
  /** trắc nghiệm with no answer that would land in the bank (new, or the bank's copy has none) */
  unanswered: number;
  /** which câu were skipped as duplicates, and what each one repeats */
  duplicate_list: string[];
  /** formulas kept but the server can't draw them for the web (no LibreOffice) */
  formula_note?: string | null;
  /** câu already in the bank without an answer, given one by this import */
  answered:   number;
  /** those `unanswered` ones, to pick A/B/C/D before importing */
  unanswered_list: UnansweredQuestion[];
  /** every trắc nghiệm of the file, with the answer it marks (-1: none) — the file đáp án */
  mcq_all:    UnansweredQuestion[];
  warnings:   string[];
}

/** A trắc nghiệm question of a file; `i` = its index in the file (answers_json key). */
export interface UnansweredQuestion {
  i:       number;
  /** its place among the file's trắc nghiệm (1 = first): the "#" shown, and what an
   *  answer file / a VJU answer key ("Phần I-II, câu n") is matched by */
  mcq_no:  number;
  /** the answer the file marks, -1 = none */
  answer:  number;
  where:   string;
  number:  string;
  content: string;
  options: string[];
}

export interface QuestionCategoryShareOut {
  id:         number;
  user_id:    number;
  email:      string;
  name:       string;
  permission: 'view' | 'edit';
  created_at: string;
}

async function rawOrThrow(res: Response): Promise<Response> {
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  const detail = (body as { detail?: unknown }).detail;
  throw new ApiError(res.status, typeof detail === 'string' ? detail : res.statusText);
}

export const questionBankApi = {
  listCategories: () =>
    request<QuestionCategoryOut[]>('/api/v1/question-bank/categories'),
  createCategory: (name: string, description?: string) =>
    request<QuestionCategoryOut>('/api/v1/question-bank/categories', { method: 'POST', body: JSON.stringify({ name, description }) }),
  updateCategory: (id: number, name: string, description?: string) =>
    request<QuestionCategoryOut>(`/api/v1/question-bank/categories/${id}`, { method: 'PUT', body: JSON.stringify({ name, description }) }),
  deleteCategory: (id: number) =>
    request<void>(`/api/v1/question-bank/categories/${id}`, { method: 'DELETE' }),
  copyCategory: (id: number) =>
    request<QuestionCategoryOut>(`/api/v1/question-bank/categories/${id}/copy`, { method: 'POST' }),

  listShares: (categoryId: number) =>
    request<QuestionCategoryShareOut[]>(`/api/v1/question-bank/categories/${categoryId}/shares`),
  share: (categoryId: number, email: string, permission: 'view' | 'edit') =>
    request<QuestionCategoryShareOut[]>(`/api/v1/question-bank/categories/${categoryId}/shares`, { method: 'POST', body: JSON.stringify({ email, permission }) }),
  unshare: (categoryId: number, shareId: number) =>
    request<void>(`/api/v1/question-bank/categories/${categoryId}/shares/${shareId}`, { method: 'DELETE' }),

  listQuestions: (categoryId: number, q?: string) =>
    request<QuestionOut[]>(`/api/v1/question-bank/categories/${categoryId}/questions${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createQuestion: (categoryId: number, payload: QuestionPayload) =>
    request<QuestionOut>(`/api/v1/question-bank/categories/${categoryId}/questions`, { method: 'POST', body: JSON.stringify(payload) }),
  updateQuestion: (id: number, payload: QuestionPayload) =>
    request<QuestionOut>(`/api/v1/question-bank/questions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteQuestion: (id: number) =>
    request<void>(`/api/v1/question-bank/questions/${id}`, { method: 'DELETE' }),
  /** Quick pick of the correct option (-1 = none yet). */
  setAnswer: (id: number, answer: number) =>
    request<QuestionOut>(`/api/v1/question-bank/questions/${id}/answer`, { method: 'PUT', body: JSON.stringify({ answer }) }),

  importFile: async (categoryId: number, file: File, dryRun: boolean,
                     answers?: Record<number, number>): Promise<QuestionImportResult> => {
    const fd = new FormData();
    fd.append('file', file);
    if (answers && Object.keys(answers).length) fd.append('answers_json', JSON.stringify(answers));
    const res = await requestRaw(`/api/v1/question-bank/categories/${categoryId}/import?dry_run=${dryRun}`, { method: 'POST', body: fd });
    return (await rawOrThrow(res)).json();
  },
  exportFile: async (categoryId: number, format: 'txt' | 'docx'): Promise<Blob> => {
    const res = await requestRaw(`/api/v1/question-bank/categories/${categoryId}/export?format=${format}`);
    return (await rawOrThrow(res)).blob();
  },
};

// ── Per-account saved state (answer keys) — see services/userStateSync.ts ───

export const userStateApi = {
  get: () => request<Record<string, unknown>>('/api/v1/me/state'),
  /** rawJson is the localStorage string as-is ('null' deletes the key). */
  put: (key: string, rawJson: string, keepalive = false) =>
    request<void>(`/api/v1/me/state/${encodeURIComponent(key)}`, { method: 'PUT', body: rawJson, keepalive }),
};

// ── Trộn đề (bộ đề = shuffled mã đề) ─────────────────────────────────────────

export type PartCounts = Record<QuestionType, number>;

export interface VersionAnswerKey {
  mcq:   string[];     // "A".."D" per trắc nghiệm question
  tf:    string[][];   // ["Đ","S","Đ","S"] per Đúng/Sai question
  short: string[];     // "-1,5" per trả lời ngắn question
}

export interface ExamPaperVersionOut {
  id:         number;
  code:       string;
  in_exam:    boolean;
  answer_key: VersionAnswerKey;
}

export interface ExamPaperOut {
  id:         number;
  name:       string;
  source:     'bank' | 'file';
  owner_id:   number;
  exam_id:    number | null;
  exam_name:  string | null;
  settings:   Record<string, unknown>;
  counts:     PartCounts;
  /** false = đề chỉ để in: không chấm được bằng phiếu Mẫu 40, không gắn kỳ thi được */
  gradable:   boolean;
  sheet_problem: string | null;
  /** answer sheet it is graded on (template id + name); null = chỉ in đề */
  sheet?:      AnswerSheet | null;
  sheet_name?: string | null;
  versions:   ExamPaperVersionOut[];
  created_at: string;
  updated_at: string;
  notes?:     string[];
}

export interface MixOptions {
  name:              string;
  num_versions:      number;
  start_code:        string;
  shuffle_questions: boolean;
  shuffle_options:   boolean;
  exam_id:           number | null;
  /** true (mặc định) = chấm bằng phiếu: tối đa 40/8/6 câu, 4 đáp án A–D */
  for_sheet?:        boolean;
  /** which answer sheet (when for_sheet): a template id from examPapersApi.sheets(); omitted = Mẫu 40 */
  sheet?:            AnswerSheet;
}

/** An answer sheet a bộ đề can be graded on: the template id (2026-10-05: any
 *  sheet in the system, not only Mẫu 40 / Phiếu Bộ GD). */
export type AnswerSheet = number;

/** What a bộ đề on that sheet may hold (read from the sheet's own answer fields). */
export interface AnswerSheetSpec {
  id:          number;
  name:        string;
  limits:      PartCounts;
  /** most options a trắc nghiệm câu may have (4 = A–D) */
  mcq_options: number;
  /** digit columns of its Mã đề box; null = no Mã đề box (1 mã đề only) */
  code_digits: number | null;
}

export interface ParsedFileInfo {
  available:        PartCounts;    // dùng được trên phiếu Mẫu 40
  available_all:    PartCounts;    // đề chỉ để in
  limits:           PartCounts;
  too_many_options: number;
  too_many_options_list: string[];   // "Câu 21 (dòng 109) "…": 5 đáp án"
  warnings:         string[];
  /** one Word file → the mã đề are built from it, formulas and pictures kept */
  keeps_format:     boolean;
  /** trắc nghiệm questions with no answer marked — the teacher picks them on the page */
  unanswered:       UnansweredQuestion[];
  /** every trắc nghiệm of the file(s), with the answer it marks (-1: none) — the file đáp án */
  mcq_all:          UnansweredQuestion[];
  /** exact repeats of an earlier câu, left out of the mix: which and what they repeat */
  duplicate_list:   string[];
  /** formulas kept but the server can't draw them for the web (no LibreOffice) */
  formula_note?:    string | null;
}

export const examPapersApi = {
  list: (examId?: number) =>
    request<ExamPaperOut[]>(`/api/v1/exam-papers${examId != null ? `?exam_id=${examId}` : ''}`),
  get: (id: number) =>
    request<ExamPaperOut>(`/api/v1/exam-papers/${id}`),
  fromBank: (opts: MixOptions & { category_ids: number[]; counts: PartCounts }) =>
    request<ExamPaperOut>('/api/v1/exam-papers/from-bank', { method: 'POST', body: JSON.stringify(opts) }),
  /** Đọc thử file đề: số câu dùng được mỗi phần (chưa tạo gì). */
  parseFile: async (files: File[]): Promise<ParsedFileInfo> => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f);
    const res = await requestRaw('/api/v1/exam-papers/parse-file', { method: 'POST', body: fd });
    return (await rawOrThrow(res)).json();
  },
  /** counts: lấy ngẫu nhiên bấy nhiêu câu mỗi phần; bỏ trống = lấy hết. */
  /** Several files = their questions pooled into one đề. */
  fromFile: async (files: File[], opts: MixOptions & { counts?: PartCounts; answers?: Record<number, number> }): Promise<ExamPaperOut> => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f);
    if (opts.counts) for (const [qt, n] of Object.entries(opts.counts)) fd.append(`count_${qt}`, String(n));
    fd.append('name', opts.name);
    fd.append('num_versions', String(opts.num_versions));
    fd.append('start_code', opts.start_code);
    fd.append('shuffle_questions', String(opts.shuffle_questions));
    fd.append('shuffle_options', String(opts.shuffle_options));
    if (opts.exam_id != null) fd.append('exam_id', String(opts.exam_id));
    if (opts.for_sheet != null) fd.append('for_sheet', String(opts.for_sheet));
    if (opts.sheet != null) fd.append('sheet', String(opts.sheet));
    if (opts.answers && Object.keys(opts.answers).length) fd.append('answers_json', JSON.stringify(opts.answers));
    const res = await requestRaw('/api/v1/exam-papers/from-file', { method: 'POST', body: fd });
    return (await rawOrThrow(res)).json();
  },
  update: (id: number, fields: { name?: string; exam_id?: number | null }) =>
    request<ExamPaperOut>(`/api/v1/exam-papers/${id}`, { method: 'PUT', body: JSON.stringify(fields) }),
  setInExam: (id: number, versionId: number, inExam: boolean) =>
    request<ExamPaperOut>(`/api/v1/exam-papers/${id}/versions/${versionId}`, { method: 'PUT', body: JSON.stringify({ in_exam: inExam }) }),
  delete: (id: number) =>
    request<void>(`/api/v1/exam-papers/${id}`, { method: 'DELETE' }),
  /** Answer key per mã đề for grading a kỳ thi (labels of the "Mẫu 40 câu" sheet). */
  /** sheet: only the bộ đề mixed for that answer sheet (omit = all of them). */
  examAnswerKey: (examId: number, sheet?: AnswerSheet) =>
    request<{ byMaDe: Record<string, Record<string, string>>; papers: string[]; versions: string[]; sheets?: AnswerSheet[];
              sheetNames?: Record<string, string> }>(
      `/api/v1/exam-papers/exam-answer-key/${examId}${sheet != null ? `?sheet=${sheet}` : ''}`),
  /** Answer sheets a bộ đề can be mixed for: the shared ones, then the teacher's own. */
  sheets: () => request<AnswerSheetSpec[]>('/api/v1/exam-papers/sheets'),
  download: async (path: string): Promise<Blob> => {
    const res = await requestRaw(`/api/v1/exam-papers/${path}`);
    return (await rawOrThrow(res)).blob();
  },
};
