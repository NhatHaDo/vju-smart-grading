/**
 * resultMapping.ts — shared DB-row → UI OmrGradeResult conversion.
 * Imported by ResultsPage, ReviewErrorsPage, ExcelPreviewPage.
 */

import type { OmrGradeResult, InfoFieldColumns } from '../types/grading';
import type { BatchResultOut } from '../services/apiClient';

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function dbRowToOmrResult(row: BatchResultOut): OmrGradeResult & { db_id: number } {
  const debugPaths = parseJson<Record<string, string | null>>(row.debug_paths_json, {});
  return {
    db_id:   row.id,
    input:   { filename: row.file_name ?? '(unknown)', saved_as: '' },
    student_info: {
      cccd:    row.cccd    ?? null,
      sbd:     row.sbd     ?? null,
      ma_de:   row.ma_de   ?? null,
      ca_thi:  row.ca_thi  ?? null,
      ma_ctdt: null,
      tu_chon: null,
    },
    answers:            parseJson<Record<string, string | null>>(row.answers_json, {}),
    warnings:           parseJson(row.warnings_json, []),
    info_field_columns: parseJson<InfoFieldColumns | undefined>(row.info_field_columns_json, undefined),
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
