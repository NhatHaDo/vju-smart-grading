/**
 * resultMapping.ts — shared DB-row → UI OmrGradeResult conversion.
 * Imported by ResultsPage, ReviewErrorsPage, ExcelPreviewPage.
 */

import type { OmrGradeResult, InfoFieldColumns, TemplateInfoField, OmrStudentInfo } from '../types/grading';
import type { BatchResultOut } from '../services/apiClient';

// ── JSON parse helper ─────────────────────────────────────────────────────────

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// ── InfoFieldColumn extraction ────────────────────────────────────────────────

/**
 * Concatenate all column values from an InfoFieldColumn array into the full
 * field value string.
 *
 * Each InfoFieldColumn.value is a single digit/letter (or "_" when blank).
 * "_" is preserved as-is so the UI can highlight ambiguous digits in red.
 *
 * Returns null if the array is empty or all values are "_".
 */
export function extractValueFromInfoFieldColumns(
  cols: import('../types/grading').InfoFieldColumn[] | undefined,
): string | null {
  if (!cols || cols.length === 0) return null;
  const val = cols.map(c => c.value).join('');
  // Consider all-blank ("____") as null
  if (!val || val.replace(/_/g, '') === '') return null;
  return val;
}

// ── Alias tables ──────────────────────────────────────────────────────────────

/** VJU canonical key → list of alternative key spellings that might appear in
 *  student_info or info_field_columns. Frontend-only; backend always uses the
 *  canonical snake_case key. */
const VJU_ALIASES: Record<string, string[]> = {
  cccd:    ['CCCD', 'so_can_cuoc', 'can_cuoc', 'student_id'],
  sbd:     ['SBD', 'so_bao_danh', 'sobao_danh'],
  ma_de:   ['made', 'maDe', 'MaDe', 'Mã đề'],
  ca_thi:  ['cathi', 'caThi', 'Ca_thi', 'Ca thi'],
  ma_ctdt: ['mactdt', 'maCTDT', 'MaCTDT', 'Mã CTĐT', 'ctdt', 'program_code'],
  tu_chon: ['tuchon', 'tuChon', 'TuChon', 'Tự chọn', 'elective'],
};

// ── getInfoFieldValue — public helper used across the app ────────────────────

/**
 * Resolve the display value of a schema info field from:
 *   1. studentInfo[field.key] — OMR-detected or corrected value
 *   2. Alias keys in studentInfo
 *   3. info_field_columns extraction by field.key
 *   4. info_field_columns extraction by alias keys
 *
 * Returns "" (empty string) when nothing is found.
 */
export function getInfoFieldValue(
  studentInfo: OmrStudentInfo,
  infoFieldCols: InfoFieldColumns | undefined,
  field: TemplateInfoField,
): string {
  const primaryKey = field.key;
  const aliases    = VJU_ALIASES[primaryKey] ?? [];
  const candidateKeys = [primaryKey, ...aliases];

  // 1 + 2: direct lookup in studentInfo
  for (const k of candidateKeys) {
    const v = studentInfo[k];
    if (v != null && String(v).trim() !== '') return String(v);
  }

  // 3 + 4: extract from info_field_columns
  if (infoFieldCols) {
    for (const k of candidateKeys) {
      const colVal = extractValueFromInfoFieldColumns(infoFieldCols[k]);
      if (colVal) return colVal;
    }
  }

  return '';
}

// ── dbRowToOmrResult ──────────────────────────────────────────────────────────

/**
 * Convert a BatchResultOut (DB row) into an OmrGradeResult for UI consumption.
 *
 * Key change vs. old version:
 *  - `ma_ctdt` and `tu_chon` (and any custom template info fields) are extracted
 *    from `info_field_columns_json` — they have no dedicated DB column.
 *  - All info_field_columns keys are spread into student_info so custom templates
 *    can also read their fields via student_info[blockName].
 */
export function dbRowToOmrResult(row: BatchResultOut): OmrGradeResult & { db_id: number } {
  const debugPaths    = parseJson<Record<string, string | null>>(row.debug_paths_json, {});
  const infoFieldCols = parseJson<InfoFieldColumns | undefined>(row.info_field_columns_json, undefined);

  // Build a flat map of key → concatenated value from info_field_columns
  const ifcValues: Record<string, string | null> = {};
  if (infoFieldCols) {
    for (const [key, cols] of Object.entries(infoFieldCols)) {
      ifcValues[key] = extractValueFromInfoFieldColumns(cols);
    }
  }

  // VJU direct DB columns take precedence (already deduplicated by DB layer)
  // Non-direct fields (ma_ctdt, tu_chon, custom blockNames) come from ifcValues
  const VJU_DIRECT = new Set(['cccd', 'sbd', 'ma_de', 'ca_thi']);

  const student_info: OmrStudentInfo = {
    cccd:    row.cccd    ?? ifcValues['cccd']    ?? null,
    sbd:     row.sbd     ?? ifcValues['sbd']     ?? null,
    ma_de:   row.ma_de   ?? ifcValues['ma_de']   ?? null,
    ca_thi:  row.ca_thi  ?? ifcValues['ca_thi']  ?? null,
    // Direct DB columns first (populated from v2+ save), fall back to info_field_columns
    ma_ctdt: (row.ma_ctdt ?? ifcValues['ma_ctdt']) ?? null,
    tu_chon: (row.tu_chon ?? ifcValues['tu_chon']) ?? null,
    // Custom template fields: any remaining ifcValues keys not already covered
    ...Object.fromEntries(
      Object.entries(ifcValues).filter(([k]) => !VJU_DIRECT.has(k) && k !== 'ma_ctdt' && k !== 'tu_chon')
    ),
  };

  return {
    db_id:   row.id,
    input:   { filename: row.file_name ?? '(unknown)', saved_as: '' },
    student_info,
    answers:            parseJson<Record<string, string | null>>(row.answers_json, {}),
    warnings:           parseJson(row.warnings_json, []),
    info_field_columns: infoFieldCols ?? undefined,
    score: {
      total:   row.total_score,
      max:     null,
      correct: null,
      wrong:   null,
      blank:   row.empty_count,
    },
    debug: {
      threshold: 0, mean_mode: '', prep_method: '', alignment_info: '',
      alignment_warnings: [], image_source: null, preprocess_strategy_used: null,
      marker_centers_detected: null, target_marker_centers: null, homography_matrix: null,
      marker_quality_score: null, warp_used: null, warp_rejected_reason: null,
      original_image_path: null, aligned_image_path: null, aligned_candidate_path: null,
      markers_debug_path: null,
      overlay_all_path:          debugPaths['overlay_all_path']          ?? null,
      overlay_marked_only_path:  debugPaths['overlay_marked_only_path']  ?? null,
      overlay_warnings_path:     debugPaths['overlay_warnings_path']     ?? null,
      means_json_path:           null,
    },
  };
}
