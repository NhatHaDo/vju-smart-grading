export interface ScoringConfig {
  correct: number;
  wrong: number;
  unanswered: number;
}

export interface AnswerKey {
  [questionId: string]: string;   // e.g. "toan1": "A"
}

export interface GradingResult {
  sheetId: number;
  studentId: string;
  answers: Record<string, string>;
  scores: Record<string, number>;
  total: number;
  sectionScores: Record<string, number>;
  needsReview: boolean;
  severity: 'ok' | 'low' | 'medium' | 'high';
  emptyCount: number;
  multiMarkCount: number;
}

export interface GradingJob {
  id: string;
  examId: number;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;        // 0–100
  total: number;
  processed: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
}

// ── OMR debug-grade API types ──────────────────────────────────────────────

export type TemplateVariant = 'sbd4' | 'sbd8';

export type ImageSource = 'auto' | 'flatbed' | 'scan_app' | 'camera';

export const IMAGE_SOURCE_LABEL: Record<ImageSource, string> = {
  auto:     'Tự động phát hiện',
  flatbed:  'Scan máy (flatbed)',
  scan_app: 'Scan app',
  camera:   'Ảnh camera điện thoại',
};

export const TEMPLATE_VARIANT_LABEL: Record<TemplateVariant, string> = {
  sbd4: 'Mẫu phiếu VJU - SBD 4 số',
  sbd8: 'Mẫu phiếu VJU - SBD 8 số',
};

/**
 * "Pinned" custom templates — shown as a quick one-click option in both the
 * Upload page's template picker and the Answer Key page's template picker
 * (2026-07-29: shared here instead of being duplicated in each page, so the
 * two pickers can't drift apart). See SheetReviewPage's original comment for
 * the id-portability caveat: the DB id is NOT the same across environments,
 * hence the env var with a production-id fallback.
 */
export const PINNED_TEMPLATE_40_ID = Number(import.meta.env.VITE_PINNED_TEMPLATE_40_ID ?? 2);
export const PINNED_TEMPLATES: { label: string; id: number }[] = [
  { label: 'Mẫu 40 câu TN + Đúng/Sai', id: PINNED_TEMPLATE_40_ID },
];

export interface OmrStudentInfo {
  cccd?:    string | null;
  sbd?:     string | null;
  ma_de?:   string | null;
  ca_thi?:  string | null;
  ma_ctdt?: string | null;
  tu_chon?: string | null;
  /** Custom template fields keyed by blockName */
  [key: string]: string | null | undefined;
}

export interface OmrWarning {
  field:      string;
  /** MCQ warnings: 'multi_mark' | 'too_light' | 'needs_review'
   *  INT warnings: 'multi_mark_info_field' | 'too_light_info_field' */
  type:       'multi_mark' | 'too_light' | 'needs_review'
            | 'multi_mark_info_field' | 'too_light_info_field';
  candidates: string[];
  /** Only present for INT-field warnings: the specific column label, e.g. "made1" */
  column?:    string;
}

/** One digit-column within an INT info field (CCCD, SBD, Mã đề, …). */
export interface InfoFieldColumn {
  columnIndex: number;
  /** Concatenated selected digits, or "_" when blank. e.g. "12" | "4" | "_" */
  value:       string;
  /** Individual digit strings in template order. Empty when blank. */
  digits:      string[];
  status:      'single' | 'multi_mark' | 'too_light' | 'blank';
}

/** Map from student-info key → per-column breakdown.
 *  VJU: "cccd" | "sbd" | "ma_de" | "ca_thi" | "ma_ctdt" | "tu_chon"
 *  Custom templates: blockName (e.g. "custom_1782375370047") */
export type InfoFieldColumns = Record<string, InfoFieldColumn[] | undefined>;

export interface OmrScore {
  total:   number | null;
  max:     number | null;
  correct: number | null;
  wrong:   number | null;
  blank:   number | null;
}

export interface OmrMarkerCenter {
  quad:     string;   // TL | TR | BR | BL
  cx:       number;
  cy:       number;
  area:     number;
  solidity: number;
}

export interface OmrDebugInfo {
  threshold:                number;
  mean_mode:                string;
  prep_method:              string;   // markers | fallback_no_warp | croppage | none
  alignment_info:           string;
  alignment_warnings:       string[];
  image_source:             ImageSource | null;
  preprocess_strategy_used: string | null;
  // ── Marker calibration ──────────────────────────────────────────────
  marker_centers_detected:  OmrMarkerCenter[] | null;
  target_marker_centers:    Record<string, [number, number]> | null;
  homography_matrix:        number[][] | null;
  // ── Quality gate ────────────────────────────────────────────────────
  marker_quality_score:     number | null;   // 0–1; null if no markers detected
  warp_used:                boolean | null;  // true = warp passed quality gate
  warp_rejected_reason:     string | null;   // reason if warp was rejected
  // ── 3 core images ───────────────────────────────────────────────────
  original_image_path:      string | null;   // raw uploaded file
  aligned_image_path:       string | null;   // final image after quality gate
  aligned_candidate_path:   string | null;   // warp output even if quality gate rejected it
  overlay_all_path:         string | null;   // bubble detection overlay on aligned_image_path
  markers_debug_path:       string | null;   // annotated original with marker boxes
  // ── Per-source calibration ─────────────────────────────────────────
  marker_centers_source_used?:      string | null;  // "scan_app" | "flatbed" | "default"
  destination_marker_centers_used?: Record<string, [number, number]> | null;
  estimated_h_stretch?:             number | null;  // % horizontal stretch vs vertical
  // ── Phase 1/2 visual + read space ──────────────────────────────────
  /** "rectified_keep_aspect" = flat warp at natural marker AR — no template H-stretch (preferred).
   *  "original_no_stretch"   = resize_fit_pad of original (legacy, no perspective correction).
   *  "warp"                  = warp to pageDimensions (may have H-stretch). */
  visual_aligned_mode?: 'rectified_keep_aspect' | 'original_no_stretch' | 'warp' | null;
  /** Pixel size [w, h] of the visual aligned image (when not in "warp" mode). */
  visual_aligned_size?: [number, number] | null;
  /** w/h aspect ratio of the visual aligned image. */
  visual_aligned_aspect_ratio?: number | null;
  /** Natural w/h aspect ratio from detected marker distances (without margin). */
  source_marker_aspect_ratio?: number | null;
  /** w/h aspect ratio of pageDimensions (template coordinate space). */
  template_aspect_ratio?: number | null;
  /** "inverse_h_original" = OMR reads via M_inv from original image (Phase 2).
   *  "warped_page_dimensions" = OMR reads from warped+resized image (current). */
  omr_read_space?:      'warped_page_dimensions' | 'inverse_h_original' | null;
  // ── Extra debug ─────────────────────────────────────────────────────
  overlay_marked_only_path: string | null;
  overlay_warnings_path:    string | null;
  means_json_path:          string | null;
}

export interface OmrGradeResult {
  input:               { filename: string; saved_as: string };
  student_info:        OmrStudentInfo;
  answers:             Record<string, string | null>;
  warnings:            OmrWarning[];
  /** Per-column breakdown of INT info fields. Present when backend >= this version. */
  info_field_columns?: InfoFieldColumns;
  score:               OmrScore;
  debug:               OmrDebugInfo;
  /** client-side only — set after fetch */
  _error?:             string;
  /** client-side only — set after POST /results/batch succeeds; used for DB delete/correction */
  db_id?:              number;
  /** client-side only — per-row template tracking (set from DB rows for mixed-template batches) */
  template_type?:         string | null;
  template_id?:           number | null;
  template_variant_row?:  string | null;
}

// ── Template schema ──────────────────────────────────────────────────────────

/** One info field (INT-type, e.g. CCCD / SBD) — drives table columns + modal header */
export interface TemplateInfoField {
  /** resultKey: VJU = "cccd"/"sbd"/..., Custom = blockName */
  key:         string;
  /** Human display label: "CCCD", "SBD", "Câu lạc bộ" */
  displayName: string;
}

/** One answer section (MCQ group, or a single composite text/decimal answer) */
export interface TemplateAnswerSection {
  name:   string;    // "Toán (Bắt buộc)", "Câu hỏi MCQ"
  labels: string[];  // ["toan1","toan2",...] or ["q1","q2",...]
  /** 'text' = free-form text/decimal answer (e.g. signed-decimal composite field).
   *  Omitted/'mcq' = standard choice grid — see `options` for the actual choices. */
  inputType?: 'mcq' | 'text';
  /** Choice values for this section's dropdown, e.g. ["A","B","C","D"] or
   *  ["Đ","S"] for a Đúng/Sai field. Omitted/empty falls back to A/B/C/D
   *  (VJU preset sections never carry this — they're always 4-choice). */
  options?: string[];
}

export interface TemplateSchema {
  infoFields:     TemplateInfoField[];
  answerSections: TemplateAnswerSection[];
}

/** VJU preset schema — mirrors hardcoded SECTION_MAP */
export const VJU_PRESET_SCHEMA: TemplateSchema = {
  infoFields: [
    { key: 'cccd',    displayName: 'CCCD'    },
    { key: 'sbd',     displayName: 'SBD'     },
    { key: 'ma_de',   displayName: 'Mã đề'   },
    { key: 'ca_thi',  displayName: 'Ca thi'  },
    { key: 'ma_ctdt', displayName: 'Mã CTĐT' },
    { key: 'tu_chon', displayName: 'Tự chọn' },
  ],
  answerSections: Object.entries({
    'Toán (Bắt buộc)': Array.from({ length: 15 }, (_, i) => `toan${i + 1}`),
    'PTBV (Bắt buộc)': Array.from({ length: 5 },  (_, i) => `ptbv${i + 1}`),
    'Vật lý':          Array.from({ length: 10 }, (_, i) => `vl${i + 1}`),
    'Hóa học':         Array.from({ length: 10 }, (_, i) => `hh${i + 1}`),
    'Sinh học':        Array.from({ length: 10 }, (_, i) => `sh${i + 1}`),
    'CNNN':            Array.from({ length: 10 }, (_, i) => `cnnn${i + 1}`),
  }).map(([name, labels]) => ({ name, labels })),
};

export interface BatchGradeState {
  templateVariant:     TemplateVariant;
  results:             OmrGradeResult[];
  gradedAt:            string;   // ISO timestamp
  examId?:             number | null;
  examName?:           string | null;
  /** 'vju' = built-in SBD4/SBD8 · 'custom' = user-defined via Define Areas */
  templateMode?:       'vju' | 'custom';
  customTemplateId?:   number | null;
  customTemplateName?: string | null;
  /** Dynamic schema — drives info columns, answer sections, modal headers */
  templateSchema?:     TemplateSchema | null;
}

// ── Answer Key ───────────────────────────────────────────────────────────────

export interface ScoringWeights {
  correct: number;
  wrong:   number;
  blank:   number;
}

/** One đề's worth of answers + its own scoring weights (used inside `byMaDe`). */
export interface AnswerKeySet {
  answers:   Record<string, string>;  // e.g. { toan1: "A", ... }
  scoring:   ScoringWeights;
  updatedAt: string;                  // ISO string
}

export interface AnswerKeyStore {
  /** Default / single-đề answer key — exams with no "Mã đề" field always use this,
   *  and it's what a single-đề exam's data has always looked like (back-compat). */
  answers:   Record<string, string>;  // e.g. { toan1: "A", ... }
  scoring:   ScoringWeights;
  updatedAt: string;                  // ISO string
  /** Per-mã-đề answer sets, keyed by the mã đề value as read by OMR (e.g. "101").
   *  Absent/empty = single-đề mode (unchanged legacy behavior — every row scores
   *  against the top-level `answers` above regardless of its own mã đề). Once at
   *  least one entry exists here, `resolveAnswerKeyForMaDe` switches to strict
   *  per-đề matching instead of falling back to the top-level set. */
  byMaDe?: Record<string, AnswerKeySet>;
}

export const DEFAULT_SCORING: ScoringWeights = { correct: 1, wrong: 0, blank: 0 };

export const AK_LS_KEY = 'vju_answer_key';

export function loadAnswerKey(): AnswerKeyStore | null {
  try {
    const raw = localStorage.getItem(AK_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AnswerKeyStore;
    if (typeof parsed.answers !== 'object' || !parsed.scoring) return null;
    return parsed;
  } catch { return null; }
}

export function saveAnswerKey(store: AnswerKeyStore): void {
  try { localStorage.setItem(AK_LS_KEY, JSON.stringify(store)); } catch { /* ignore */ }
}

export function clearAnswerKey(): void {
  try { localStorage.removeItem(AK_LS_KEY); } catch { /* ignore */ }
}

/** True once the answer key has at least one đề-specific set defined —
 *  i.e. the exam is using the "chia theo mã đề" (split by exam code) feature. */
export function isMultiMaDe(store: AnswerKeyStore | null): boolean {
  return !!store?.byMaDe && Object.keys(store.byMaDe).length > 0;
}

/** True when the given template schema has a "Mã đề" info field — used to decide
 *  whether AnswerKeyPage should even offer the multi-đề tabs UI. VJU preset always
 *  has it; custom templates only if the user declared a MaDe-labelled field. */
export function schemaHasMaDe(schema: TemplateSchema | null | undefined): boolean {
  if (!schema) return false;
  return schema.infoFields.some(f => f.key === 'ma_de' || /mã\s*đề/i.test(f.displayName));
}

// ── Last-used template (2026-07-29) ────────────────────────────────────────
// AnswerKeyPage previously had no idea which custom template the user was
// actually working with unless it was opened via the "Upload → chấm phiếu"
// flow (which passes the schema through router navigation state). Opening
// Answer Key directly from the sidebar always silently fell back to
// VJU_PRESET_SCHEMA, showing the wrong question list for anyone using a
// custom template — the user then had to go back through the upload flow
// just to get the right schema loaded, purely to edit answers. Persisted
// (not sessionStorage — must survive opening a fresh tab/browser restart)
// so AnswerKeyPage can restore the right schema on its own.
export interface LastUsedTemplate {
  mode: 'vju' | 'custom';
  id:   number | null;
  name: string | null;
}

const LAST_TEMPLATE_KEY = 'vju_last_template';

export function saveLastUsedTemplate(t: LastUsedTemplate): void {
  try { localStorage.setItem(LAST_TEMPLATE_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

export function loadLastUsedTemplate(): LastUsedTemplate | null {
  try {
    const raw = localStorage.getItem(LAST_TEMPLATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastUsedTemplate;
    if (parsed.mode !== 'vju' && parsed.mode !== 'custom') return null;
    return parsed;
  } catch { return null; }
}

// ── Per-template answer key drafts (2026-07-29) ────────────────────────────
// AnswerKeyPage only ever had ONE "live" answer key (AK_LS_KEY below) shared
// across every template — every scoring/results/analytics page reads that
// single key, matching the reality that only one template's answers can be
// "active for grading" at a time. That's fine for grading, but it meant
// switching templates in the Answer Key editor to work on a different one
// would silently overwrite whatever was there on save. These functions add a
// separate per-template DRAFT slot purely for the editor UI: switching the
// template dropdown saves/restores each template's in-progress answers
// independently, with zero risk to the single active key everything else
// reads — "Lưu Answer Key" still writes to AK_LS_KEY (via saveAnswerKey) to
// make that template's answers the one actually used for grading, exactly
// like before, in addition to updating its own draft slot.
export type TemplateStoreKey = string; // 'vju' | `custom:${id}`

export function templateStoreKeyFor(mode: 'vju' | 'custom', id: number | null): TemplateStoreKey {
  return mode === 'custom' && id != null ? `custom:${id}` : 'vju';
}

const AK_DRAFTS_KEY = 'vju_answer_key_drafts';

function loadAnswerKeyDraftsMap(): Record<string, AnswerKeyStore> {
  try {
    const raw = localStorage.getItem(AK_DRAFTS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, AnswerKeyStore>;
  } catch { /* ignore */ }
  return {};
}

function saveAnswerKeyDraftsMap(map: Record<string, AnswerKeyStore>): void {
  try { localStorage.setItem(AK_DRAFTS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

export function loadAnswerKeyDraft(templateKey: TemplateStoreKey): AnswerKeyStore | null {
  return loadAnswerKeyDraftsMap()[templateKey] ?? null;
}

export function saveAnswerKeyDraft(templateKey: TemplateStoreKey, store: AnswerKeyStore): void {
  const map = loadAnswerKeyDraftsMap();
  map[templateKey] = store;
  saveAnswerKeyDraftsMap(map);
}

export function clearAnswerKeyDraft(templateKey: TemplateStoreKey): void {
  const map = loadAnswerKeyDraftsMap();
  delete map[templateKey];
  saveAnswerKeyDraftsMap(map);
}

// ── Saved answer-key library (2026-07-29) ──────────────────────────────────
// Separate from the single "active" key (AK_LS_KEY) and the per-template
// drafts above — this is a named, persistent history the user builds up on
// purpose ("Lưu vào thư viện") so a past exam's answer key can be found and
// re-used or cross-checked later, even after other work has overwritten the
// active key/draft for that template. Requested directly by the user
// ("lưu mẫu cả đáp án để sau còn tra cứu lại").
export interface SavedAnswerKeyEntry {
  id:            string;            // stable id, safe to use as a React key
  name:          string;            // user-given label, e.g. "Đáp án Toán K12 - Cuối kì HK1"
  savedAt:       string;            // ISO timestamp
  templateKey:   TemplateStoreKey;  // which template this answer key belongs to
  templateLabel: string;            // display-name snapshot (template may be renamed/deleted later)
  store:         AnswerKeyStore;
}

const AK_LIBRARY_KEY = 'vju_answer_key_library';

export function loadAnswerKeyLibrary(): SavedAnswerKeyEntry[] {
  try {
    const raw = localStorage.getItem(AK_LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveAnswerKeyLibraryList(list: SavedAnswerKeyEntry[]): void {
  try { localStorage.setItem(AK_LIBRARY_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export function addToAnswerKeyLibrary(entry: Omit<SavedAnswerKeyEntry, 'id' | 'savedAt'>): SavedAnswerKeyEntry {
  const full: SavedAnswerKeyEntry = {
    ...entry,
    id:      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    savedAt: new Date().toISOString(),
  };
  const list = loadAnswerKeyLibrary();
  list.unshift(full);
  saveAnswerKeyLibraryList(list);
  return full;
}

export function removeFromAnswerKeyLibrary(id: string): void {
  saveAnswerKeyLibraryList(loadAnswerKeyLibrary().filter(e => e.id !== id));
}

/** Overwrite a saved entry's answers in place (used by the preview popup's
 *  inline edit — "có thể sửa được nữa"), refreshing its savedAt so the
 *  library list reflects the latest edit time. Returns the updated entry,
 *  or null if the id no longer exists (e.g. deleted in another tab). */
export function updateAnswerKeyLibraryEntry(id: string, store: AnswerKeyStore): SavedAnswerKeyEntry | null {
  const list = loadAnswerKeyLibrary();
  const idx = list.findIndex(e => e.id === id);
  if (idx === -1) return null;
  const updated: SavedAnswerKeyEntry = { ...list[idx], store, savedAt: new Date().toISOString() };
  list[idx] = updated;
  saveAnswerKeyLibraryList(list);
  return updated;
}

/** Renames a saved entry ("cả sửa được tên này nữa") without touching its
 *  answers or savedAt. Returns the updated entry, or null if not found. */
export function renameAnswerKeyLibraryEntry(id: string, name: string): SavedAnswerKeyEntry | null {
  const list = loadAnswerKeyLibrary();
  const idx = list.findIndex(e => e.id === id);
  if (idx === -1) return null;
  const updated: SavedAnswerKeyEntry = { ...list[idx], name };
  list[idx] = updated;
  saveAnswerKeyLibraryList(list);
  return updated;
}

/**
 * Find the mã đề value inside a student_info object.
 *
 * VJU preset templates always key it "ma_de". Custom templates DON'T — the
 * backend's per-template extraction (`_extract_student_info_custom` in
 * omr.py) keys every info field by its block name, e.g. "custom_1782375370047",
 * whatever the template author happened to name it when drawing the field.
 * Reading `student_info.ma_de` directly on a custom-template result is always
 * undefined, which silently made mã-đề matching fail for every row on any
 * custom template ("Đề ?", "chưa có đáp án" on sheets that plainly show a mã
 * đề). The schema's infoFields tells us which key actually holds it.
 */
export function getMaDeValue(
  studentInfo: OmrStudentInfo | null | undefined,
  schema: TemplateSchema | null | undefined,
): string | null {
  if (!studentInfo) return null;
  const field = schema?.infoFields.find(f => f.key === 'ma_de' || /mã\s*đề/i.test(f.displayName));
  const key = field?.key ?? 'ma_de';
  return studentInfo[key] ?? null;
}

/**
 * Resolve which answer set applies to a given sheet's mã đề.
 *
 * - Single-đề mode (`byMaDe` empty/absent): always returns the top-level set —
 *   exactly the old behavior, so existing exams are unaffected.
 * - Multi-đề mode: looks up `maDe` in `byMaDe`. No match (mã đề unreadable, or a
 *   đề the user hasn't entered answers for yet) → returns `null` with
 *   `missingKeyForMaDe: true` instead of silently guessing, so the caller can
 *   flag the sheet as "cần kiểm tra" rather than showing a wrong score.
 */
export function resolveAnswerKeyForMaDe(
  store: AnswerKeyStore | null,
  maDe: string | null | undefined,
): { key: AnswerKeySet | null; missingKeyForMaDe: boolean } {
  if (!store) return { key: null, missingKeyForMaDe: false };
  if (!isMultiMaDe(store)) {
    return { key: { answers: store.answers, scoring: store.scoring, updatedAt: store.updatedAt }, missingKeyForMaDe: false };
  }
  const trimmed = (maDe ?? '').trim();
  const set = trimmed ? store.byMaDe![trimmed] : undefined;
  if (!set) return { key: null, missingKeyForMaDe: true };
  return { key: set, missingKeyForMaDe: false };
}

/** Compute per-sheet score given answers and key. */
export function computeScore(
  sheetAnswers: Record<string, string | null>,
  key: AnswerKeySet | AnswerKeyStore,
): { correct: number; wrong: number; blank: number; total: number } {
  const keyed = Object.keys(key.answers);
  let correct = 0, wrong = 0, blank = 0;
  for (const q of keyed) {
    const student = sheetAnswers[q] ?? null;
    const correct_ans = key.answers[q];
    if (!correct_ans) continue;          // no answer defined for this question
    if (!student)       { blank++;  continue; }
    if (student === correct_ans) correct++;
    else                         wrong++;
  }
  const total =
    correct * key.scoring.correct +
    wrong   * key.scoring.wrong   +
    blank   * key.scoring.blank;
  return { correct, wrong, blank, total: Math.round(total * 100) / 100 };
}

// ── Section map ─────────────────────────────────────────────────────────────

export const SECTION_MAP: Record<string, string[]> = {
  'Toán (Bắt buộc)': Array.from({ length: 15 }, (_, i) => `toan${i + 1}`),
  'PTBV (Bắt buộc)': Array.from({ length: 5 },  (_, i) => `ptbv${i + 1}`),
  'Vật lý':          Array.from({ length: 10 }, (_, i) => `vl${i + 1}`),
  'Hóa học':         Array.from({ length: 10 }, (_, i) => `hh${i + 1}`),
  'Sinh học':        Array.from({ length: 10 }, (_, i) => `sh${i + 1}`),
  'CNNN':            Array.from({ length: 10 }, (_, i) => `cnnn${i + 1}`),
};

// ── Manual Corrections ───────────────────────────────────────────────────────

export interface ManualCorrection {
  corrected_student_info: Partial<OmrStudentInfo>;
  corrected_answers: Record<string, string>;
  updatedAt: string;
}

/** key = correctionKey(batchId, filename) — see below. Was plain filename before;
 *  kept as a loose string type so old localStorage data still parses fine. */
export type CorrectionsStore = Record<string, ManualCorrection>;

export const CORRECTIONS_LS_KEY = 'vju_manual_corrections';

/**
 * Build the storage key for a manual correction.
 *
 * Previously corrections were keyed by filename alone, which meant re-uploading
 * a brand-new grading batch that happened to reuse a filename (very common when
 * testing with the same sample scans, or re-scanning a sheet) would silently
 * resurrect an old "đã sửa tay" edit from a completely unrelated batch — the new
 * batch looked pre-corrected with stale data the user never touched this time.
 * `batchId` (typically `batch.gradedAt`, a fresh ISO timestamp per grading run)
 * scopes each correction to the specific batch it was made in.
 */
export function correctionKey(batchId: string | null | undefined, filename: string): string {
  return `${batchId || 'nobatch'}::${filename}`;
}

export function loadCorrections(): CorrectionsStore {
  try {
    const raw = localStorage.getItem(CORRECTIONS_LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as CorrectionsStore;
  } catch { return {}; }
}

export function saveCorrections(store: CorrectionsStore): void {
  try { localStorage.setItem(CORRECTIONS_LS_KEY, JSON.stringify(store)); } catch { /* ignore */ }
}

export function clearCorrections(): void {
  try { localStorage.removeItem(CORRECTIONS_LS_KEY); } catch { /* ignore */ }
}

/** Merge OMR result with correction (correction wins) */
export function applyCorrection(r: OmrGradeResult, c: ManualCorrection | undefined): {
  student_info: OmrStudentInfo;
  answers: Record<string, string | null>;
} {
  if (!c) return { student_info: r.student_info, answers: r.answers };
  return {
    student_info: { ...r.student_info, ...c.corrected_student_info },
    answers:      { ...r.answers,      ...c.corrected_answers },
  };
}
