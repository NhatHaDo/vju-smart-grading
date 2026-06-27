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

/** One answer section (MCQ group) */
export interface TemplateAnswerSection {
  name:   string;    // "Toán (Bắt buộc)", "Câu hỏi MCQ"
  labels: string[];  // ["toan1","toan2",...] or ["q1","q2",...]
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

export interface AnswerKeyStore {
  answers:   Record<string, string>;  // e.g. { toan1: "A", ... }
  scoring:   ScoringWeights;
  updatedAt: string;                  // ISO string
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

/** Compute per-sheet score given answers and key. */
export function computeScore(
  sheetAnswers: Record<string, string | null>,
  key: AnswerKeyStore,
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

export type CorrectionsStore = Record<string, ManualCorrection>; // key = filename

export const CORRECTIONS_LS_KEY = 'vju_manual_corrections';

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
