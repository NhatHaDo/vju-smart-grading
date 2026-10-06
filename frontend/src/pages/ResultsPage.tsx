import { useConfirm } from '../components/modals/useConfirm';
import { saveGradedImages, saveResultsBundle } from '../utils/gradedImages';
import { buildResultsExcelFile } from '../utils/exportResultsExcel';
import { useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback, useRef } from 'react';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Badge from '../components/common/Badge';
import PageHeader from '../components/layout/PageHeader';
import { Download, Eye, AlertTriangle, CheckCircle2, Trash2, ArrowLeft, Key, Database, WifiOff, TableProperties, ChevronDown, X, Search } from 'lucide-react';
import type { BatchGradeState, OmrGradeResult, AnswerKeyStore, CorrectionsStore, InfoFieldColumns, TemplateSchema, ManualCorrection, ProctorInfo } from '../types/grading';
import { TEMPLATE_VARIANT_LABEL, VJU_PRESET_SCHEMA, loadAnswerKey, loadCorrections, saveCorrections, clearCorrections, computeScore, applyCorrection, resolveAnswerKeyForMaDe, isMultiMaDe, correctionKey, getMaDeValue } from '../types/grading';
import ResultDetailModal from '../components/results/ResultDetailModal';
import ExcelPreviewModal from '../components/results/ExcelPreviewModal';
import { resultsApi, examsApi, customFormsApi, hasToken, ApiError, type ResultBatchSaveRequest } from '../services/apiClient';
import { buildSchemaFromDetail, getRowTemplateKey, getRowTemplateLabel, buildTemplateOptionsFromRows } from '../utils/templateSchema';
import type { TemplateFilterOption } from '../utils/templateSchema';
import type { ExamOut } from '../types/exam';
import { dbRowToOmrResult, correctionHasChanges } from '../utils/resultMapping';

// ── Name/DOB thumbnail helper (2026-08-06) ──────────────────────────────────
// Same path-resolution logic as imgUrl() in SheetImageViewer.tsx / OverlayLink()
// in OmrDebugPage.tsx — debug.*_path can be an absolute filesystem path
// (production) or relative (local dev); only the "outputs/"/"uploads/" tail is
// an actual route the backend exposes (see app.mount() in main.py).
const RESULTS_BACKEND = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000';
function nameDobCropUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  const norm = path.replace(/\\/g, '/');
  const idx  = Math.max(norm.lastIndexOf('outputs/'), norm.lastIndexOf('uploads/'));
  const relative = idx >= 0 ? norm.slice(idx) : norm.replace(/^\//, '');
  return `${RESULTS_BACKEND}/${relative}`;
}

const LS_KEY = 'vju_last_batch_grade';

// ── LocalStorage helpers ───────────────────────────────────────────────────

function loadFromStorage(): BatchGradeState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BatchGradeState;
    if (!parsed || !parsed.templateVariant || !Array.isArray(parsed.results)) {
      localStorage.removeItem(LS_KEY);
      return null;
    }
    return parsed;
  } catch {
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
    return null;
  }
}

function clearStorage() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

// ── DB result converter ────────────────────────────────────────────────────
// 2026-07-31: this used to be a local, stale duplicate of the shared
// dbRowToOmrResult() in utils/resultMapping.ts — it never parsed ma_ctdt/
// tu_chon from info_field_columns_json (hardcoded null) and, as of this
// change, wouldn't have carried `signatures` either. Now imports the shared
// version (see resultMapping.ts) so ResultsPage — and everything downstream
// of it, including the Excel export — gets the same, fully-featured
// conversion as ReviewErrorsPage/ExcelPreviewPage already use.

// ── Template label helper ──────────────────────────────────────────────────

// ── "Lượt chấm" (grading batch/session) helpers ─────────────────────────────
// A row's own `graded_at` (see resultMapping.ts) is the grouping key. Falls
// back to `batch.gradedAt` for rows from a batch just graded in this session
// (not yet round-tripped through the DB, so r.graded_at is still undefined).
function rowGradedAt(r: OmrGradeResult, batch: BatchGradeState | null): string | null {
  return r.graded_at ?? batch?.gradedAt ?? null;
}

function formatGradedAtLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 2026-10-06 "mấy cái ko gắn với kì thi thì sao ? lọc nnao ?" — a lượt chấm
// in the list says where it came from, not only its time.
function gradedAtSource(rows: OmrGradeResult[]): string {
  const names = rows.map(r => r.input?.filename ?? '');
  if (names.length && names.every(n => n.startsWith('cham-nhanh_'))) return 'Chấm nhanh';
  if (names.length && names.every(n => n.startsWith('camera_'))) return 'Chụp bằng camera';
  return 'Tải ảnh lên';
}

function getBatchTemplateLabel(b: BatchGradeState): string {
  if (b.templateMode === 'custom') {
    // 2026-08-07: bỏ tiền tố "Custom template —" cho đồng nhất với
    // getRowTemplateLabel() ở utils/templateSchema.ts — chỉ hiện tên mẫu
    // phiếu thật, không lộ thuật ngữ nội bộ ra badge.
    return b.customTemplateName ?? 'Mẫu phiếu tự tạo';
  }
  return TEMPLATE_VARIANT_LABEL[b.templateVariant] ?? b.templateVariant;
}

// ── Template filter helpers ─────────────────────────────────────────────────
// getRowTemplateKey / getRowTemplateLabel / TemplateFilterOption now live in
// utils/templateSchema.ts (2026-07-29) — shared with ExcelPreviewPage's own
// exam/template selector, which needs the exact same per-row grouping logic.

// ── Batch save request builder ─────────────────────────────────────────────

function buildBatchSaveRequest(batch: BatchGradeState, examId?: number | null): ResultBatchSaveRequest {
  const isCustom = batch.templateMode === 'custom';
  return {
    template_type:    isCustom ? 'custom' : 'vju',
    template_variant: isCustom ? null : batch.templateVariant,
    template_id:      isCustom ? (batch.customTemplateId ?? null) : null,
    exam_id:          examId ?? batch.examId ?? null,
    graded_at:        batch.gradedAt,
    items: batch.results
      .filter(r => !r._error)
      .map(r => ({
        file_name:          r.input?.filename ?? 'unknown',
        template_type:      isCustom ? 'custom' : 'vju',
        template_variant:   isCustom ? null : batch.templateVariant,
        template_id:        isCustom ? (batch.customTemplateId ?? null) : null,
        cccd:               r.student_info?.cccd   ?? null,
        sbd:                r.student_info?.sbd    ?? null,
        ma_de:              r.student_info?.ma_de  ?? null,
        ca_thi:             r.student_info?.ca_thi  ?? null,
        ma_ctdt:            r.student_info?.ma_ctdt ?? null,
        tu_chon:            r.student_info?.tu_chon ?? null,
        answers:            r.answers              ?? {},
        scores:             {},
        sections:           {},
        total_score:        0,
        severity:           'ok',
        needs_review:       (r.warnings ?? []).length > 0,
        empty_count:        0,
        multi_mark_count:   (r.warnings ?? []).filter(w => w.type === 'multi_mark').length,
        warnings:           r.warnings             ?? [],
        info_field_columns: r.info_field_columns   ?? null,
        // 2026-07-31: "file export kết quả cần hiện cả Giám thị coi thi đã
        // kí tên hay chưa" — carry the signature ink-detection result
        // through to the DB so it survives past this grading session (see
        // signatures_json on BatchResult / giamThiLabel() in the Excel
        // builder). Previously dropped here entirely.
        signatures:         r.signatures            ?? null,
        debug_paths: {
          overlay_all_path:         r.debug?.overlay_all_path         ?? null,
          overlay_marked_only_path: r.debug?.overlay_marked_only_path ?? null,
          overlay_warnings_path:    r.debug?.overlay_warnings_path    ?? null,
          // Previously dropped here: the per-file grade response DOES include
          // these two (see backend app/api/v1/routes/omr.py's debug-grade
          // response), but the batch-save payload never carried them through,
          // so "Ảnh đã căn chỉnh" / "Ảnh gốc" tabs in Sửa thủ công / kết quả
          // chi tiết always showed "Không có ảnh debug" for anything saved
          // via batch grading (2026-07-28).
          original_image_path:     r.debug?.original_image_path      ?? null,
          aligned_image_path:      r.debug?.aligned_image_path       ?? null,
          // 2026-08-06: crop riêng "Họ và tên"/"Ngày sinh" — hiện thumbnail
          // ở cột riêng trong bảng Kết quả (xem RealRow bên dưới).
          name_dob_crop_path:      r.debug?.name_dob_crop_path       ?? null,
        },
      })),
  };
}

// ── CSV export ─────────────────────────────────────────────────────────────

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function hasInfoMultiMark(r: OmrGradeResult): boolean {
  return (r.warnings ?? []).some(w => w.type === 'multi_mark_info_field');
}

/** OMR-detected missing signatures ("CÁN BỘ COI THI/CHẤM THI" boxes left
 *  blank) — null/undefined `signatures` means "not checked" (custom
 *  template), not "all missing", so that case returns [].
 *
 * 2026-07-31: "thế thì cần tick làm gì? phải là nếu ko tick thì ko phát hiện
 * chứ nhỉ" — this used to flag every unsigned box regardless of the "Có cán
 * bộ coi thi / chấm thi" checkboxes on Answer Key, making those checkboxes
 * decorative. Now gated: a missing coi_thi_* box only becomes a warning if
 * "Có cán bộ coi thi" is ticked for this row's mã đề (same for cham_thi) —
 * unticked = that role isn't expected on this đề, so an empty box isn't
 * a problem worth flagging. */
function missingSignatures(r: OmrGradeResult, proctors: ProctorInfo | null | undefined): string[] {
  return (r.signatures ?? [])
    .filter(s => !s.present)
    .filter(s => !!proctors?.[s.key.startsWith('coi_thi') ? 'coi_thi' : 'cham_thi'])
    .map(s => s.label);
}

function infoFieldMultiMarkTooltip(
  cols: InfoFieldColumns[keyof InfoFieldColumns] | undefined,
  label: string,
): string | null {
  if (!cols) return null;
  const multi = cols.filter(c => c.status === 'multi_mark');
  if (multi.length === 0) return null;
  return multi.map(c => `${label} cột ${c.columnIndex + 1} có nhiều ô tô: ${c.digits.join(',')}`).join('; ');
}

function buildInfoWarningsCsv(r: OmrGradeResult): string {
  const ifc = r.info_field_columns;
  if (!ifc) return '';
  const parts: string[] = [];
  const labelMap: Record<string, string> = {
    cccd: 'CCCD', sbd: 'SBD', ma_de: 'Mã đề',
    ca_thi: 'Ca thi', ma_ctdt: 'Mã CTĐT', tu_chon: 'Tự chọn',
  };
  for (const [key, cols] of Object.entries(ifc)) {
    if (!cols) continue;
    const multi = cols.filter(c => c.status === 'multi_mark');
    for (const c of multi) {
      parts.push(`${labelMap[key] ?? key} cột ${c.columnIndex + 1} có nhiều ô tô: ${c.digits.join(',')}`);
    }
  }
  return parts.join('; ');
}

function exportCsv(
  batch: BatchGradeState,
  answerKey: AnswerKeyStore | null,
  results?: OmrGradeResult[],
  tplLabel?: string,
  templateNames?: Map<number, string>,
  getRowSchema?: (r: OmrGradeResult) => TemplateSchema,
) {
  const tplSlug = (tplLabel ?? (batch.templateMode === 'custom'
    ? (batch.customTemplateName ?? 'custom')
    : batch.templateVariant)).replace(/\s+/g, '_');
  const headers = [
    'filename','status','template','cccd','sbd','ma_de','ca_thi','ma_ctdt','tu_chon',
    'warnings_count','warnings_json','info_field_warnings','answers_json',
    'correct_count','wrong_count','blank_count','score_total','graded_at',
  ];
  const rows = (results ?? batch.results ?? []).map(r => {
    const rowSchema = getRowSchema ? getRowSchema(r) : VJU_PRESET_SCHEMA;
    const { key } = resolveAnswerKeyForMaDe(answerKey, getMaDeValue(r.student_info, rowSchema));
    const sc = key ? computeScore(r.answers ?? {}, key) : null;
    return [
      r.input?.filename ?? '',
      r._error ? 'error' : 'ok',
      getRowTemplateLabel(r, batch, templateNames),
      r.student_info?.cccd ?? '', r.student_info?.sbd ?? '',
      r.student_info?.ma_de ?? '', r.student_info?.ca_thi ?? '',
      r.student_info?.ma_ctdt ?? '', r.student_info?.tu_chon ?? '',
      (r.warnings ?? []).length,
      JSON.stringify(r.warnings ?? []),
      buildInfoWarningsCsv(r),
      JSON.stringify(r.answers ?? {}),
      sc?.correct ?? '', sc?.wrong ?? '', sc?.blank ?? '', sc?.total ?? '',
      batch.gradedAt,
    ];
  });
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  const ts = new Date(batch.gradedAt).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const filename = `vju_omr_results_${tplSlug}_${ts}.csv`;
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function hasWarnings(r: OmrGradeResult) { return (r.warnings ?? []).length > 0; }
/** Stable per-row key for bulk-select — mirrors the key already used for the table's .map(). */
function rowKey(r: OmrGradeResult): string { return String(r.db_id ?? r.input?.filename ?? ''); }
function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleString('vi-VN', { hour12: false }); } catch { return iso; }
}

// ── RealRow ────────────────────────────────────────────────────────────────

function RealRow({ idx, r, merged, corrected, sc, missingKeyForMaDe, maDeValue, onOpen, onDelete, infoFields, showTemplateCol, templateLabel, rowIdentityFields, selected, onToggleSelect, proctors }: {
  idx:             number;
  r:               OmrGradeResult;
  merged:          { student_info: OmrGradeResult['student_info']; answers: Record<string, string | null> };
  corrected:       boolean;
  sc:              { correct: number; wrong: number; blank: number; total: number } | null;
  /** true when the exam is split by mã đề and this sheet's mã đề has no matching answer key entered */
  missingKeyForMaDe?: boolean;
  /** resolved via getMaDeValue() — the schema-correct field, not necessarily student_info.ma_de */
  maDeValue?: string | null;
  onOpen:          () => void;
  onDelete:        () => void;
  infoFields:      import('../types/grading').TemplateInfoField[];
  showTemplateCol?: boolean;
  templateLabel?:  string;
  /** 2026-08-04: "Tất cả mẫu phiếu" mode's per-row identifying fields (up to
   *  2, resolved from THIS row's own template — see resolveRowSchema() at
   *  the call site) — mixed-template rows have no single fixed column that
   *  fits every row, so this replaces the single "Mẫu phiếu"-only view with
   *  each row's own MSV/SBD/CCCD/... label:value pairs. */
  rowIdentityFields?: import('../types/grading').TemplateInfoField[];
  selected:        boolean;
  onToggleSelect:  () => void;
  /** "Có cán bộ coi thi/chấm thi" checkboxes for this row's mã đề — gates missingSignatures(). */
  proctors:        ProctorInfo | null;
}) {
  const warn      = hasWarnings(r) || !!missingKeyForMaDe;
  const hasIMM    = hasInfoMultiMark(r);
  const missingSigs = missingSignatures(r, proctors);
  const info   = merged.student_info;
  const ifc    = r.info_field_columns;

  function InfoCell({ value, iKey, label, extraStyle = {} }: {
    value:       string | null | undefined;
    iKey:        string;
    label:       string;
    extraStyle?: React.CSSProperties;
  }) {
    const tooltip = infoFieldMultiMarkTooltip(ifc?.[iKey], label);
    return (
      <td style={{ padding: '11px 10px', fontFamily: 'monospace', ...extraStyle }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title={tooltip ?? undefined}>
          {value ?? '—'}
          {tooltip && <AlertTriangle size={11} color="#CA8A04" style={{ flexShrink: 0 }} />}
        </span>
      </td>
    );
  }

  return (
    <tr
      onClick={onOpen}
      style={{ borderBottom: '1px solid #F3F4F6', background: selected ? '#FEF2F2' : warn ? '#FFF5F5' : '#fff', cursor: 'pointer' }}
    >
      <td style={{ padding: '11px 10px' }} onClick={e => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={onToggleSelect} style={{ accentColor: '#C8102E', width: 15, height: 15, cursor: 'pointer' }} />
      </td>
      <td style={{ padding: '11px 10px', color: '#9CA3AF' }}>{idx}</td>
      <td style={{ padding: '11px 10px' }}>
        <div style={{ fontWeight: 600, color: '#1E1E1E', display: 'flex', alignItems: 'center', gap: 4 }}>
          {r.input?.filename ?? '—'}
          {warn && !hasIMM && (
            <span title="Có câu tô nhiều đáp án" style={{ display: 'inline-flex' }}>
              <AlertTriangle size={12} color="#C8102E" />
            </span>
          )}
          {hasIMM && (
            <span title={buildInfoWarningsCsv(r) || 'Có nhiều ô tô trong cột thông tin'} style={{ display: 'inline-flex' }}>
              <AlertTriangle size={12} color="#C8102E" />
            </span>
          )}
          {r._error && <span style={{ fontSize: 10, color: '#EF4444', fontWeight: 400 }}>ERR</span>}
          {corrected && <span style={{ fontSize: 10, color: '#10B981', fontWeight: 700, background: '#D1FAE5', borderRadius: 4, padding: '1px 5px' }}>Đã sửa tay</span>}
          {missingSigs.length > 0 && (
            <span
              title={`Thiếu chữ ký: ${missingSigs.join(', ')}`}
              style={{ fontSize: 10, color: '#B45309', fontWeight: 700, background: '#FEF3C7', borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}
            >
              Thiếu chữ ký
            </span>
          )}
        </div>
        {r._error && <div style={{ fontSize: 10, color: '#EF4444', marginTop: 2 }}>{r._error.slice(0, 80)}</div>}
      </td>
      <td style={{ padding: '6px 10px', maxWidth: 260 }}>
        {/* 2026-08-07: "t thấy cái ảnh bị bé đi, cho to lên đi" — cột co
           theo maxWidth:'100%' đang bị các cột khác ép nhỏ hơn cần thiết.
           Tăng kích thước mục tiêu lên 260px (td maxWidth theo cùng) — vẫn
           giữ maxWidth:'100%' để không tái diễn tràn ngang khi thật sự
           thiếu chỗ, nhưng giờ có nhiều chỗ hơn để hiện to, rõ chữ hơn. */}
        {nameDobCropUrl(r.debug?.name_dob_crop_path) ? (
          <img
            src={nameDobCropUrl(r.debug?.name_dob_crop_path)!}
            alt="Họ và tên / Ngày sinh"
            title="Họ và tên / Ngày sinh"
            style={{ maxWidth: '100%', width: 260, height: 'auto', maxHeight: 58, display: 'block', borderRadius: 5, border: '1px solid #E5E7EB' }}
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <span style={{ color: '#D1D5DB', fontSize: 11 }}>—</span>
        )}
      </td>
      {showTemplateCol
        ? <>
            <td style={{ padding: '11px 10px', fontSize: 11, fontFamily: 'monospace' }}>
              {rowIdentityFields && rowIdentityFields.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {rowIdentityFields.map(field => (
                    <span key={field.key} title={field.displayName}>
                      <span style={{ color: '#9CA3AF', fontFamily: 'inherit', fontWeight: 400 }}>{field.displayName}: </span>
                      <span style={{ color: '#C8102E', fontWeight: 600 }}>{info?.[field.key] ?? '—'}</span>
                    </span>
                  ))}
                </div>
              ) : '—'}
            </td>
            <td style={{ padding: '11px 10px', fontSize: 11, maxWidth: 140 }}>
              {/* 2026-08-07: "nếu tên dài thì xuống dòng là được, sẽ có chỗ,
                 sẽ ko bị kéo sang" — bỏ nowrap ở đây (thường là chuỗi dài
                 nhất trong hàng, ví dụ "Custom - Mẫu 40 câu TN + Đúng/Sai")
                 để nó tự xuống dòng trong khung thay vì ép cả bảng tràn
                 ngang. maxWidth trên <td> giữ cột này không phình quá to
                 khi có phòng, nhưng vẫn co lại được khi thiếu chỗ. */}
              <span style={{ background: '#F3F4F6', color: '#374151', borderRadius: 9999, padding: '2px 8px', fontWeight: 600, display: 'inline-block', lineHeight: 1.3 }}>
                {templateLabel ?? '—'}
              </span>
            </td>
          </>
        : infoFields.map((field, fi) => (
            <InfoCell
              key={field.key}
              value={info?.[field.key] ?? null}
              iKey={field.key}
              label={field.displayName}
              extraStyle={fi === 0 ? { color: '#C8102E', fontWeight: 600 } : undefined}
            />
          ))
      }
      {sc !== null ? (
        <>
          <td style={{ padding: '11px 10px', color: '#065F46', fontWeight: 600 }}>{sc.correct}</td>
          <td style={{ padding: '11px 10px', color: '#991B1B', fontWeight: 600 }}>{sc.wrong}</td>
          <td style={{ padding: '11px 10px', color: '#6B7280' }}>{sc.blank}</td>
          <td style={{ padding: '11px 10px', fontWeight: 800, color: '#1E1E1E', fontSize: 13 }}>{sc.total}</td>
        </>
      ) : missingKeyForMaDe ? (
        <td colSpan={4} style={{ padding: '11px 10px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#CA8A04' }}
            title="Chưa nhập đáp án cho mã đề này ở trang Answer Key">
            <AlertTriangle size={12} /> Chưa có đáp án — Đề {maDeValue ?? '?'}
          </span>
        </td>
      ) : null}
      <td style={{ padding: '11px 10px' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onOpen}
            style={{ border: '1.5px solid #E5E7EB', borderRadius: 9999, padding: '3px 10px', background: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 3, color: '#374151' }}>
            <Eye size={11} /> Xem
          </button>
          <button onClick={onDelete}
            style={{ border: '1.5px solid #FECACA', borderRadius: 9999, padding: '3px 10px', background: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 3, color: '#EF4444' }}>
            <Trash2 size={11} /> Xoá
          </button>
        </div>
      </td>
    </tr>
  );
}

/** One result as a card, for phones (2026-10-05: on a narrow screen the
 *  table pushed Điểm, mã đề and Xem/Xoá off to the right). Same data and
 *  actions as RealRow; the table stays as it is on wider screens. */
function RealCard({ idx, r, merged, corrected, sc, missingKeyForMaDe, maDeValue, onOpen, onDelete, identityFields, selected, onToggleSelect, proctors }: {
  idx: number; r: OmrGradeResult;
  merged: { student_info: OmrGradeResult['student_info']; answers: Record<string, string | null> };
  corrected: boolean;
  sc: { correct: number; wrong: number; blank: number; total: number } | null;
  missingKeyForMaDe?: boolean; maDeValue?: string | null;
  onOpen: () => void; onDelete: () => void;
  identityFields: import('../types/grading').TemplateInfoField[];
  selected: boolean; onToggleSelect: () => void;
  proctors: ProctorInfo | null;
}) {
  const warn = hasWarnings(r) || !!missingKeyForMaDe || hasInfoMultiMark(r);
  const missingSigs = missingSignatures(r, proctors);
  const info = merged.student_info;
  const crop = nameDobCropUrl(r.debug?.name_dob_crop_path);
  return (
    <div onClick={onOpen}
      style={{ border: `1.5px solid ${selected ? '#FCA5A5' : warn ? '#FECACA' : '#E5E7EB'}`, borderRadius: 12, padding: 12,
        background: selected ? '#FEF2F2' : warn ? '#FFF7F7' : '#fff', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <input type="checkbox" checked={selected} onClick={e => e.stopPropagation()} onChange={onToggleSelect}
          style={{ accentColor: '#C8102E', width: 18, height: 18, marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1E1E1E', wordBreak: 'break-word' }}>
            <span style={{ color: '#9CA3AF', fontWeight: 600 }}>{idx}. </span>{r.input?.filename ?? '—'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 3, fontSize: 12 }}>
            {identityFields.map(f => (
              <span key={f.key}><span style={{ color: '#9CA3AF' }}>{f.displayName}: </span>
                <b style={{ color: '#C8102E', fontFamily: 'monospace' }}>{info?.[f.key] ?? '—'}</b></span>
            ))}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {sc !== null
            ? <><div style={{ fontSize: 22, fontWeight: 800, color: '#1E1E1E', lineHeight: 1 }}>{sc.total}</div>
                <div style={{ fontSize: 10.5, color: '#9CA3AF', marginTop: 2 }}>điểm</div></>
            : missingKeyForMaDe
              ? <span style={{ fontSize: 11, fontWeight: 700, color: '#CA8A04' }}>Chưa có đáp án<br />Đề {maDeValue ?? '?'}</span>
              : null}
        </div>
      </div>
      {crop && (
        <img src={crop} alt="Họ và tên / Ngày sinh"
          style={{ width: '100%', height: 'auto', maxHeight: 64, objectFit: 'contain', objectPosition: 'left', borderRadius: 6, border: '1px solid #E5E7EB', background: '#fff' }}
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
        {sc !== null && <>
          <span style={{ color: '#065F46', fontWeight: 700 }}>Đúng {sc.correct}</span>
          <span style={{ color: '#991B1B', fontWeight: 700 }}>Sai {sc.wrong}</span>
          <span style={{ color: '#6B7280' }}>Trống {sc.blank}</span>
        </>}
        {warn && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#C8102E', fontWeight: 700 }}><AlertTriangle size={12} /> Cần xem</span>}
        {corrected && <span style={{ fontSize: 10.5, color: '#10B981', fontWeight: 700, background: '#D1FAE5', borderRadius: 4, padding: '1px 5px' }}>Đã sửa tay</span>}
        {missingSigs.length > 0 && <span style={{ fontSize: 10.5, color: '#B45309', fontWeight: 700, background: '#FEF3C7', borderRadius: 4, padding: '1px 5px' }}>Thiếu chữ ký</span>}
        {r._error && <span style={{ fontSize: 10.5, color: '#EF4444', fontWeight: 700 }}>Lỗi: {r._error.slice(0, 60)}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={e => { e.stopPropagation(); onDelete(); }}
          style={{ border: '1.5px solid #FECACA', borderRadius: 9999, padding: '5px 12px', background: '#fff', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4, color: '#EF4444' }}>
          <Trash2 size={12} /> Xoá
        </button>
      </div>
    </div>
  );
}

// ── DB Save status banner ──────────────────────────────────────────────────

type DbSaveStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'auth_failed';
type DataSource   = 'init' | 'db' | 'localStorage';

// 2026-07-29: this whole header area used to mix blue/green/red/amber/yellow
// banners + colorful summary-card accents — "quá nhiều màu, design lại đi
// (max 2 màu)". Collapsed the palette down to just neutral gray/white for
// anything informational, and red (brand color) reserved for things that
// actually need attention (errors, unsaved data, review needed). Meaning is
// carried by icon + wording instead of hue.
const NEUTRAL_BANNER = { background: '#F9FAFB', border: '1px solid #E5E7EB', color: '#374151' };
const ALERT_BANNER   = { background: '#FEF2F2', border: '1px solid #F3B4BC', color: '#991B1B' };

function DbStatusBanner({ status }: { status: DbSaveStatus }) {
  if (status === 'idle') return null;
  if (status === 'saving') return (
    <div style={{ ...NEUTRAL_BANNER, borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <Database size={14} /> Đang lưu kết quả…
    </div>
  );
  if (status === 'saved') return (
    <div style={{ ...NEUTRAL_BANNER, borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <Database size={14} /> Đã lưu kết quả
    </div>
  );
  if (status === 'auth_failed') return (
    <div style={{ ...ALERT_BANNER, borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <WifiOff size={14} /> Phiên đăng nhập đã hết hạn — kết quả chưa được lưu. Vui lòng đăng nhập lại.
    </div>
  );
  return (
    <div style={{ ...ALERT_BANNER, borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <WifiOff size={14} /> Không lưu được kết quả lên hệ thống — đang giữ tạm trong trình duyệt
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

export default function ResultsPage() {
  const location  = useLocation();
  const navigate  = useNavigate();

  const rawState = location.state as BatchGradeState | { batch: BatchGradeState } | null;
  const navBatch: BatchGradeState | null = (() => {
    if (!rawState) return null;
    if ('batch' in (rawState as object) && (rawState as { batch: BatchGradeState }).batch)
      return (rawState as { batch: BatchGradeState }).batch;
    const s = rawState as BatchGradeState;
    if (s.templateVariant && Array.isArray(s.results)) return s;
    return null;
  })();

  const [batch,         setBatch]         = useState<BatchGradeState | null>(null);
  const [answerKey,     setAnswerKey]      = useState<AnswerKeyStore | null>(null);
  const [corrections,   setCorrections]    = useState<CorrectionsStore>({});
  const [modalRow,      setModalRow]       = useState<OmrGradeResult | null>(null);
  // 2026-07-31: "ở màn results cho giảng viên sửa trực tiếp luôn; không cần
  // trang review-errors nữa" — ResultDetailModal already supports full
  // editing right here (handleSaveCorrection above), so the separate
  // /app/review-errors page is redundant. Instead of navigating away,
  // "Kiểm tra lỗi" / "Kiểm tra ngay →" now just filter this same table down
  // to flagged rows and open the first one in the modal.
  const [reviewOnly,    setReviewOnly]     = useState(false);
  // 2026-07-31: "trang results cũng để action hàng loạt nhé, ví dụ a muốn
  // xóa vẫn phải xóa từng cái" — checkbox-select rows + bulk delete, instead
  // of one confirm dialog per row. Keyed the same way table rows already
  // are (db_id when saved, else filename) so it stays stable across renders.
  const [selectedKeys,  setSelectedKeys]   = useState<Set<string>>(new Set());
  const [exportToast,       setExportToast]       = useState(false);
  const [showExcelPreview,  setShowExcelPreview]  = useState(false);
  const [dataSource,    setDataSource]     = useState<DataSource>('init');
  const [dbSaveStatus,  setDbSaveStatus]   = useState<DbSaveStatus>('idle');

  // ── Exam + template filter context ───────────────────────────────────────
  const [selectedExamId,      setSelectedExamId]      = useState<number | null>(null);
  const [selectedExamName,    setSelectedExamName]    = useState<string | null>(null);
  const [exams,               setExams]               = useState<ExamOut[]>([]);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>('all');
  // 2026-08-03: "kết quả và export cũng cần hiển thị theo kì thi/ lượt chấm —
  // hiện tại danh sách này đang ở cùng 1 nơi cho tất cả các bài chấm" —
  // separate from the exam filter above: within one exam, group/filter rows
  // by which grading session ("lượt chấm") produced them. Auto-derived from
  // each row's own graded_at (all rows saved from the same handleGradeNow()
  // call share the exact same ISO timestamp — see AnswerKeyPage.tsx line
  // ~849 `gradedAt: new Date().toISOString()` — so exact-match grouping is
  // reliable without needing a dedicated batch_id column in the DB).
  const [selectedGradedAt, setSelectedGradedAt] = useState<string>('all');
  // 2026-08-04: "cũng ko thấy có bộ lọc theo msv hay sbd ở đây" — a quick
  // find-a-student box, independent of the "hard" scoping filters above
  // (kỳ thi/lượt chấm/mẫu phiếu/kiểm tra lỗi, which also affect stats and
  // export). Matches against the filename AND every value in that row's own
  // student_info (CCCD/SBD/MSV/Mã đề/... — whatever fields that row's own
  // template actually has), so it works regardless of which template a row
  // belongs to, without needing to know which exact field name to search.
  const [searchQuery, setSearchQuery] = useState('');

  // Schema cache for custom templates loaded from DB (which don't carry templateSchema)
  const [fetchedSchemas, setFetchedSchemas] = useState<Map<number, TemplateSchema>>(new Map());
  // Real template name (e.g. "temp3") for custom templates loaded from DB — same
  // fetch as fetchedSchemas above, since syntheticBatch has no customTemplateName.
  const [fetchedTemplateNames, setFetchedTemplateNames] = useState<Map<number, string>>(new Map());
  // Track which IDs have already been fetched (or attempted) — prevents duplicate requests
  const fetchedSchemaIdsRef = useRef<Set<number>>(new Set());

  // Prevents calling saveBatch more than once for the same grading session
  // (guards against React StrictMode double-invoke and HMR re-mounts).
  const savedBatchKeyRef = useRef<string | null>(null);

  // ── Load exams list ────────────────────────────────────────────────────────

  useEffect(() => {
    examsApi.list().then(setExams).catch(() => { /* ignore — dropdown is optional */ });
  }, []);

  // ── Init: save fresh batch or load from DB ─────────────────────────────

  const initData = useCallback(async () => {
    setAnswerKey(loadAnswerKey());
    setCorrections(loadCorrections());

    if (navBatch && Array.isArray(navBatch.results) && navBatch.results.length > 0) {
      // Fresh batch from grading — extract exam context from batch
      const eid  = navBatch.examId   ?? null;
      const ename= navBatch.examName ?? null;
      setSelectedExamId(eid);
      setSelectedExamName(ename);

      // Show immediately, save to DB in background
      setBatch(navBatch);
      try { localStorage.setItem(LS_KEY, JSON.stringify(navBatch)); } catch { /* ignore */ }
      setDataSource('localStorage');

      // Build a stable key for this batch to prevent duplicate saves
      const batchKey = `${navBatch.gradedAt}|${navBatch.results.map(r => r.input?.filename ?? '').join('|')}`;
      const alreadySaved = navBatch.results.some(r => r.db_id);
      const alreadySentThisMount = savedBatchKeyRef.current === batchKey;

      if (!alreadySaved && !alreadySentThisMount) {
        // Guard: skip if no token — avoids a guaranteed 401
        if (!hasToken()) {
          setDbSaveStatus('auth_failed');
          return;
        }
        savedBatchKeyRef.current = batchKey;
        setDbSaveStatus('saving');
        try {
          const req = buildBatchSaveRequest(navBatch, eid);
          if (req.items.length > 0) {
            const resp = await resultsApi.saveBatch(req);
            // Attach db_ids to results (zip: items only includes non-error results)
            let dbIdx = 0;
            const updatedResults = navBatch.results.map(r => {
              if (r._error) return r;
              const db_id = resp.ids[dbIdx++];
              return db_id ? { ...r, db_id } : r;
            });
            const updatedBatch = { ...navBatch, results: updatedResults };
            setBatch(updatedBatch);
            try { localStorage.setItem(LS_KEY, JSON.stringify(updatedBatch)); } catch { /* ignore */ }
          }
          setDbSaveStatus('saved');
        } catch (err) {
          console.warn('[ResultsPage] DB save failed:', err);
          if (err instanceof ApiError && err.status === 401) {
            // Token expired mid-session — show specific auth banner, don't retry
            setDbSaveStatus('auth_failed');
            savedBatchKeyRef.current = null; // allow retry after re-login
          } else {
            setDbSaveStatus('failed');
          }
        }
      } else {
        setDbSaveStatus('idle');
      }
      return;
    }

    // No fresh batch: resolve examId from localStorage, then load DB
    const lsBatch = loadFromStorage();
    const resolvedExamId   = lsBatch?.examId   ?? null;
    const resolvedExamName = lsBatch?.examName ?? null;
    if (resolvedExamId !== null) {
      setSelectedExamId(resolvedExamId);
      setSelectedExamName(resolvedExamName);
    }

    // Try DB first (filter by exam if we know which one)
    try {
      const params: Parameters<typeof resultsApi.list>[0] = { limit: 500 };
      if (resolvedExamId !== null) params.exam_id = resolvedExamId;
      const resp = await resultsApi.list(params);
      if (resp.items.length > 0) {
        const converted = resp.items.map(dbRowToOmrResult);
        const firstItem = resp.items[0];
        const examIdFromDb = firstItem.exam_id ?? null;
        const syntheticBatch: BatchGradeState = {
          templateVariant: (firstItem.template_variant as BatchGradeState['templateVariant']) ?? 'sbd8',
          results:         converted,
          gradedAt:        firstItem.graded_at,
          examId:          examIdFromDb,
          examName:        resolvedExamName,
        };
        if (examIdFromDb !== null && selectedExamId === null) {
          setSelectedExamId(examIdFromDb);
        }
        setBatch(syntheticBatch);
        setDataSource('db');
        return;
      }
    } catch (err) {
      console.warn('[ResultsPage] DB load failed, fallback localStorage:', err);
    }

    // Fallback to localStorage
    setBatch(lsBatch);
    setDataSource('localStorage');
    if (!lsBatch) setDbSaveStatus('idle'); // nothing to persist — clear any stale failed banner
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => { initData(); }, [initData]);

  // ── Auto-fetch schemas for custom-template rows that have no schema ────────
  //    (happens when results come from DB — syntheticBatch has no templateSchema)
  useEffect(() => {
    if (!batch) return;
    const safeR = batch.results && Array.isArray(batch.results) ? batch.results : [];
    const missingIds: number[] = [];
    for (const r of safeR) {
      if (r.template_type === 'custom' && r.template_id != null) {
        const alreadyInBatch = batch.templateSchema != null && batch.customTemplateId === r.template_id;
        if (!alreadyInBatch && !fetchedSchemaIdsRef.current.has(r.template_id)) {
          fetchedSchemaIdsRef.current.add(r.template_id); // mark immediately — prevent double-fetch
          missingIds.push(r.template_id);
        }
      }
    }
    if (missingIds.length === 0) return;
    Promise.all(
      missingIds.map(id =>
        customFormsApi.get(id)
          .then(detail => ({ id, schema: buildSchemaFromDetail(detail), name: detail.name }))
          .catch(() => null)
      )
    ).then(results => {
      const updates = results.filter(Boolean) as { id: number; schema: TemplateSchema; name: string }[];
      if (updates.length === 0) return;
      setFetchedSchemas(prev => {
        const next = new Map(prev);
        for (const { id, schema } of updates) next.set(id, schema);
        return next;
      });
      setFetchedTemplateNames(prev => {
        const next = new Map(prev);
        for (const { id, name } of updates) next.set(id, name);
        return next;
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch]);

  // ── Reload DB results when user switches exam ─────────────────────────────

  const loadByExam = useCallback(async (eid: number | null, ename: string | null) => {
    setSelectedExamId(eid);
    setSelectedExamName(ename);
    setSelectedTemplateKey('all'); // reset template filter when exam changes
    setSelectedGradedAt('all');    // reset lượt chấm filter when exam changes
    setSearchQuery('');            // reset search box when exam changes
    setBatch(null);
    setDataSource('init');
    setSelectedKeys(new Set());
    setReviewOnly(false);
    try {
      const params: Parameters<typeof resultsApi.list>[0] = { limit: 500 };
      if (eid !== null) params.exam_id = eid;
      const resp = await resultsApi.list(params);
      if (resp.items.length > 0) {
        const converted = resp.items.map(dbRowToOmrResult);
        const first = resp.items[0];
        const syntheticBatch: BatchGradeState = {
          templateVariant: (first.template_variant as BatchGradeState['templateVariant']) ?? 'sbd8',
          results:         converted,
          gradedAt:        first.graded_at,
          examId:          eid,
          examName:        ename,
        };
        setBatch(syntheticBatch);
        setDataSource('db');
      } else {
        setDataSource('db'); // no results for this exam
      }
    } catch (err) {
      console.warn('[ResultsPage] loadByExam failed:', err);
      setDataSource('localStorage');
    }
  }, []);

  // Auto-dismiss "saved" banner after 4 s
  useEffect(() => {
    if (dbSaveStatus !== 'saved') return;
    const t = setTimeout(() => setDbSaveStatus('idle'), 4000);
    return () => clearTimeout(t);
  }, [dbSaveStatus]);

  // ── Delete / Clear ─────────────────────────────────────────────────────

  // 2026-10-06: "các nút chọn xoá hay xoá tất cả đều ko dùng được (trong chấm
  // nhanh)" — window.confirm() does nothing inside the Google app / Zalo
  // browsers teachers use on phones; an in-page dialog instead. Rows are
  // matched by their own key (db id), not the file name, which can repeat.
  const [confirmDialog, confirm] = useConfirm();
  const [pageNotice, setPageNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingImages, setSavingImages] = useState(false);
  const downloadImages = async (rows: OmrGradeResult[]) => {
    if (rows.length === 0) return;
    setSavingImages(true);
    setPageNotice(null);
    try {
      const n = await saveGradedImages(rows);
      if (n > 0) setPageNotice({ ok: true, text: n === rows.length ? `Đã tải ${n} ảnh bài chấm.` : `Đã tải ${n}/${rows.length} ảnh, ${rows.length - n} bài không có ảnh.` });
    } catch (e) {
      setPageNotice({ ok: false, text: (e as Error).message });
    } finally {
      setSavingImages(false);
    }
  };

  // 2026-10-06: "kiểu tải cả bảng excel + các ảnh trong 1 folder ấy" — one
  // .zip: the results Excel (same as Xuất Excel) + every bài's graded picture,
  // for the phiếu shown (kỳ thi / mẫu phiếu / tìm kiếm filters)
  const [bundling, setBundling] = useState(false);
  const downloadBundle = async () => {
    if (!batch) return;
    if (isAllMode && multipleTemplates) {
      setPageNotice({ ok: false, text: 'Chọn một mẫu phiếu cụ thể ở ô "Mẫu phiếu" trước khi tải tất cả (mỗi file Excel chỉ cho một mẫu phiếu).' });
      return;
    }
    const rows = visibleScoredRows.map(x => x.r);
    if (rows.length === 0) return;
    setBundling(true);
    setPageNotice(null);
    try {
      const excel = await buildResultsExcelFile({
        batch: { ...batch, templateSchema: selectedTemplateOpt?.templateSchema ?? batch.templateSchema },
        results: rows, answerKey, corrections,
        dataSource: dataSource === 'db' ? 'Database' : 'Trình duyệt (localStorage)',
        examName: selectedExamName ?? batch.examName ?? null,
        includeReview: true, includeAnswers: true, highlightReview: true,
      });
      const d = new Date();
      const pad = (x: number) => String(x).padStart(2, '0');
      const lot = isAllGradedAt ? null : gradedAtOptions.find(([iso]) => iso === selectedGradedAt);
      const folder = lot && !selectedExamName
        ? `${lot[2]} ${formatGradedAtLabel(lot[0]).replace(/\//g, '-').replace(':', 'h')}`
        : `Ket qua ${selectedExamName ?? 'cham'} ${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
      const n = await saveResultsBundle(rows, excel, folder);
      setPageNotice({ ok: true, text: `Đã tải file Excel và ${n}/${rows.length} ảnh bài chấm.` });
    } catch (e) {
      console.error(e);
      setPageNotice({ ok: false, text: 'Không tải được, thử lại sau.' });
    } finally {
      setBundling(false);
    }
  };

  const handleDeleteRow = async (filename: string, db_id?: number) => {
    if (!(await confirm(<>Xoá kết quả <b>{filename}</b>?</>, { okLabel: 'Xoá', danger: true }))) return;
    const key = String(db_id ?? filename);
    if (db_id) {
      try { await resultsApi.deleteOne(db_id); }
      catch (e) { setPageNotice({ ok: false, text: 'Không xoá được trên máy chủ, thử lại sau.' }); console.warn('[DB delete]', e); return; }
    }
    setSelectedKeys(prev => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setBatch(prev => {
      if (!prev) return prev;
      const newResults = prev.results.filter(r => rowKey(r) !== key);
      if (newResults.length === 0) { clearStorage(); return null; }
      const updated = { ...prev, results: newResults };
      try { localStorage.setItem(LS_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
      return updated;
    });
    setCorrections(prev => {
      const next = { ...prev };
      delete next[correctionKey(batch?.gradedAt, filename)];
      saveCorrections(next);
      return next;
    });
  };

  const toggleSelectRow = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const toggleSelectAllVisible = () => {
    setSelectedKeys(prev => {
      const visibleKeys = searchedRows.map(({ r }) => rowKey(r));
      const allSelected  = visibleKeys.length > 0 && visibleKeys.every(k => prev.has(k));
      if (allSelected) {
        const next = new Set(prev);
        for (const k of visibleKeys) next.delete(k);
        return next;
      }
      return new Set([...prev, ...visibleKeys]);
    });
  };

  // 2026-10-06 "mấy nút xoá ở đây ko hoạt động": one DELETE per phiếu, all
  // at once (155–230 requests) was refused by the web server in front of the
  // app. Now the ids go in one request (a few for very long lists).
  const deleteOnServer = async (rows: OmrGradeResult[]) => {
    const ids = rows.map(r => r.db_id).filter((id): id is number => typeof id === 'number');
    for (let i = 0; i < ids.length; i += 2000) {
      await resultsApi.deleteMany(ids.slice(i, i + 2000));
    }
  };
  const errText = (e: unknown) =>
    e instanceof ApiError ? `lỗi ${e.status}` : ((e as Error)?.message || 'lỗi mạng');

  const handleBulkDelete = async () => {
    const targets = safeResults.filter(r => selectedKeys.has(rowKey(r)));
    if (targets.length === 0) return;
    if (!(await confirm(<>Xoá <b>{targets.length} phiếu</b> đã chọn? Không hoàn tác được.</>, { okLabel: 'Xoá', danger: true }))) return;
    // wait for the server: leaving the page right away must not leave some
    // behind. One request for all of them (see deleteOnServer).
    try {
      await deleteOnServer(targets);
    } catch (e) {
      setPageNotice({ ok: false, text: `Chưa xoá được trên máy chủ (${errText(e)}), thử lại sau.` });
      return;
    }
    const targetFilenames = new Set(targets.map(r => r.input?.filename ?? ''));
    const targetKeys = new Set(targets.map(rowKey));
    setBatch(prev => {
      if (!prev) return prev;
      const newResults = prev.results.filter(r => !targetKeys.has(rowKey(r)));
      if (newResults.length === 0) { clearStorage(); return null; }
      const updated = { ...prev, results: newResults };
      try { localStorage.setItem(LS_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
      return updated;
    });
    setCorrections(prev => {
      const next = { ...prev };
      for (const fname of targetFilenames) delete next[correctionKey(batch?.gradedAt, fname)];
      saveCorrections(next);
      return next;
    });
    setSelectedKeys(new Set());
  };

  const handleClear = async () => {
    const n = batch?.results?.length ?? 0;
    const what = selectedExamName ? <>của kỳ thi <b>{selectedExamName}</b></> : <>đang hiện ở đây</>;
    if (!(await confirm(<>Xoá tất cả <b>{n} phiếu</b> {what}? Không hoàn tác được.</>, { okLabel: 'Xoá tất cả', danger: true }))) return;
    // DB: the whole kỳ thi when one is chosen; otherwise ONLY the phiếu on
    // this page (with no kỳ thi, deleteAll() would wipe every result of the
    // account — e.g. after Chấm nhanh without a kỳ thi)
    try {
      if (selectedExamId !== null) {
        await resultsApi.deleteAll({ exam_id: selectedExamId });
      } else {
        await deleteOnServer(batch?.results ?? []);
      }
    } catch (e) {
      console.warn('[DB clear]', e);
      setPageNotice({ ok: false, text: `Chưa xoá được trên máy chủ (${errText(e)}), tải lại trang rồi thử lại.` });
      return;
    }
    clearStorage();
    try { localStorage.removeItem('vju_pending_grade'); } catch { /* ignore */ }
    setBatch(null);
    clearCorrections();
    setCorrections({});
    setSelectedKeys(new Set());
    setDataSource('localStorage');
    setDbSaveStatus('idle');
    savedBatchKeyRef.current = null;
  };

  // ── Derived state ──────────────────────────────────────────────────────

  const safeResults = batch?.results && Array.isArray(batch.results) ? batch.results : [];
  const hasBatch    = safeResults.length > 0;
  const hasKey      = !!answerKey && (Object.keys(answerKey.answers ?? {}).length > 0 || isMultiMaDe(answerKey));

  // Build template options from all rows in the current exam — shared logic
  // with ExcelPreviewPage (utils/templateSchema.ts), including the
  // "custom:unknown" fallback for rows with no resolvable template_type
  // (2026-07-29 fix — previously defaulted to VJU's schema, which showed the
  // wrong column headers and "—" for every info cell on rows actually
  // graded with a different form).
  const templateOptions: TemplateFilterOption[] = buildTemplateOptionsFromRows(
    safeResults, batch, fetchedSchemas, fetchedTemplateNames,
  );

  const multipleTemplates  = templateOptions.length > 1;
  const isAllMode          = selectedTemplateKey === 'all';
  const selectedTemplateOpt = templateOptions.find(o => o.key === selectedTemplateKey) ?? null;

  // Per-row schema resolution (used by modal)
  const resolveRowSchema = (r: OmrGradeResult): TemplateSchema => {
    const key = getRowTemplateKey(r, batch);
    return templateOptions.find(o => o.key === key)?.templateSchema
      ?? { infoFields: [], answerSections: [] };
  };

  // Active info fields for table columns (empty in all-mode)
  const activeInfoFields = isAllMode ? [] : (selectedTemplateOpt?.templateSchema.infoFields ?? []);

  // schemaMissing: warn when a known custom batch has no schema stored
  const schemaMissing = !!(batch?.templateMode === 'custom' && !batch?.templateSchema);

  // All rows scored
  const allScoredRows = safeResults.map(r => {
    const filename = r.input?.filename ?? '';
    const corr     = corrections[correctionKey(batch?.gradedAt, filename)];
    const merged   = applyCorrection(r, corr);
    const maDeValue = getMaDeValue(merged.student_info, resolveRowSchema(r));
    const { key, missingKeyForMaDe } = hasKey
      ? resolveAnswerKeyForMaDe(answerKey, maDeValue)
      : { key: null, missingKeyForMaDe: false };
    return { r, merged, corr, sc: key ? computeScore(merged.answers ?? {}, key) : null, missingKeyForMaDe, maDeValue, proctors: key?.proctors ?? null };
  });

  // 2026-07-30: "check lỗi cần cho GV sửa trực tiếp ở màn view, hiện tại đang
  // tách màn chỉnh sửa ở 1 page khác" — same persistence logic ReviewErrorsPage
  // uses (localStorage + fire-and-forget DB save), just triggered from here so
  // corrections can be made straight from the result-detail modal too.
  const handleSaveCorrection = (filename: string, c: ManualCorrection) => {
    const next = { ...corrections, [correctionKey(batch?.gradedAt, filename)]: c };
    setCorrections(next);
    saveCorrections(next);
    const result = safeResults.find(r => (r.input?.filename ?? '') === filename);
    if (result?.db_id) {
      resultsApi.saveCorrection(result.db_id, {
        corrected_answers:      c.corrected_answers,
        corrected_student_info: c.corrected_student_info as Record<string, string>,
        mark_as_reviewed:       true,
      }).catch(err => console.warn('[Results] DB correction failed:', err));
    }
  };
  const handleResetCorrection = (filename: string) => {
    const next = { ...corrections };
    delete next[correctionKey(batch?.gradedAt, filename)];
    setCorrections(next);
    saveCorrections(next);
  };

  // Distinct grading sessions ("lượt chấm") present in the current exam's
  // rows, newest first (ISO strings sort lexically). Only meaningful when
  // there's more than one — a single-session exam has nothing to filter.
  const gradedAtOptions = Array.from(
    safeResults.reduce((map, r) => {
      const key = rowGradedAt(r, batch);
      if (key) map.set(key, [...(map.get(key) ?? []), r]);
      return map;
    }, new Map<string, OmrGradeResult[]>()).entries()
  ).sort((a, b) => b[0].localeCompare(a[0]))
    .map(([iso, rows]) => [iso, rows.length, gradedAtSource(rows)] as const);
  const multipleGradedAt = gradedAtOptions.length > 1;
  const isAllGradedAt    = selectedGradedAt === 'all';

  // Rows visible after lượt chấm filter, then template filter
  const gradedAtFilteredRows = isAllGradedAt
    ? allScoredRows
    : allScoredRows.filter(({ r }) => rowGradedAt(r, batch) === selectedGradedAt);
  const templateFilteredRows = isAllMode
    ? gradedAtFilteredRows
    : gradedAtFilteredRows.filter(({ r }) => getRowTemplateKey(r, batch) === selectedTemplateKey);
  const visibleScoredRows = reviewOnly
    ? templateFilteredRows.filter(({ r, missingKeyForMaDe }) => hasWarnings(r) || !!missingKeyForMaDe)
    : templateFilteredRows;

  // 2026-08-04: quick find-a-student search — narrows only what the TABLE
  // shows (and "chọn tất cả" checkbox), not the stats/export above, which
  // stay scoped to the "hard" filters (kỳ thi/lượt chấm/mẫu phiếu/kiểm tra
  // lỗi) exactly as before search existed.
  //
  // 2026-08-07: bỏ so khớp theo tên file — trước gõ gì cũng dò luôn vào
  // r.input.filename, mà ảnh chụp camera có tên là chuỗi hash ngẫu nhiên
  // (vd "z8093749426404_ae3a1892a6101efd2f32233c51ad445f.jpg"), nên gõ 1
  // số bất kỳ như "233" rất dễ vô tình khớp trúng đoạn hash, ra kết quả
  // không liên quan gì tới MSV/SBD/CCCD — trong khi ô search ghi rõ "Tìm
  // theo MSV, SBD, CCCD...". Giờ chỉ khớp đúng như placeholder hứa: dữ
  // liệu học sinh trong student_info.
  const searchedRows = (() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return visibleScoredRows;
    return visibleScoredRows.filter(({ merged }) => {
      const info = merged.student_info ?? {};
      return Object.values(info).some(v => v != null && String(v).toLowerCase().includes(q));
    });
  })();

  // 2026-07-31: "sao ấn kiểm tra ngay thì n đưa vào màn hình này, show cái
  // list cần ktra là được rồi" — this used to also auto-open the first
  // flagged row's detail modal, skipping straight past the filtered list.
  // Just filter the table now; the teacher picks which row to open, and can
  // get back to the full list via the "Xem tất cả" button that replaces
  // "Kiểm tra lỗi" in the header while reviewOnly is active.
  const startReview = () => {
    setReviewOnly(true);
  };

  const scores      = visibleScoredRows.map(x => x.sc?.total ?? null).filter((s): s is number => s !== null);
  const avgScore    = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null;
  const maxScore    = scores.length ? Math.max(...scores) : null;
  const minScore    = scores.length ? Math.min(...scores) : null;
  // Always computed off the template filter alone (not reviewOnly), so these
  // stay stable while a teacher is stepping through the review-only view
  // instead of jumping around as the table shrinks to just flagged rows.
  const warnCount   = templateFilteredRows.filter(({ r, missingKeyForMaDe }) => hasWarnings(r) || !!missingKeyForMaDe).length;
  const totalSheets = templateFilteredRows.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title={selectedExamName ? `Kết quả: ${selectedExamName}` : 'Kết quả & Export'}
        subtitle="Xem điểm, ảnh detect, tải CSV và chấm lại khi cần"
        actions={<>
          <Button variant="secondary" size="sm" icon={<ArrowLeft size={14} />} onClick={() => navigate('/app/upload')}>Quay lại Upload</Button>
          {hasBatch && (
            reviewOnly ? (
              <Button variant="secondary" size="sm" icon={<X size={14} />} onClick={() => setReviewOnly(false)}>
                Xem tất cả
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon={<AlertTriangle size={14} />} onClick={startReview}>
                Kiểm tra lỗi
              </Button>
            )
          )}
          {hasBatch && (
            <Button variant="secondary" size="sm" icon={<TableProperties size={14} />}
              onClick={() => {
                if (isAllMode && multipleTemplates) {
                  alert('Vui lòng chọn một mẫu phiếu cụ thể trước khi xem trước Excel.');
                  return;
                }
                navigate('/app/excel-preview');
              }}>
              Xem trước Excel
            </Button>
          )}
          <Button
            variant="outline" size="sm" icon={<Download size={14} />}
            onClick={() => {
              if (!hasBatch || !batch) { alert('Chưa có kết quả để xuất Excel.'); return; }
              if (isAllMode && multipleTemplates) {
                alert('Vui lòng chọn một mẫu phiếu cụ thể trước khi xuất Excel.');
                return;
              }
              setShowExcelPreview(true);
            }}
            style={!hasBatch ? { opacity: 0.45, pointerEvents: 'none' } : undefined}
          >Xuất Excel</Button>
          {hasBatch && batch && (
            <Button variant="secondary" size="sm" icon={<Download size={14} />}
              onClick={() => {
                if (isAllMode && multipleTemplates) {
                  alert('Vui lòng chọn một mẫu phiếu cụ thể trước khi xuất CSV.');
                  return;
                }
                exportCsv(batch, answerKey, visibleScoredRows.map(x => x.r), selectedTemplateOpt?.label, fetchedTemplateNames, resolveRowSchema);
              }}>
              Xuất CSV
            </Button>
          )}
          {hasBatch && (
            <Button variant="secondary" size="sm" icon={<Trash2 size={14} />} onClick={() => { void handleClear(); }}
              style={{ color: '#EF4444', borderColor: '#FECACA' }}>
              Xóa kết quả
            </Button>
          )}
        </>}
      />

      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Exam + Template filter ─────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: '12px 16px' }}>
          {/* Row 1: Exam selector */}
          {exams.length > 0 && (
            <div className="results-filter-row" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="results-filter-label" style={{ fontSize: 13, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', minWidth: 76 }}>Kỳ thi:</span>
              <div className="results-filter-select" style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
                <select
                  value={selectedExamId ?? ''}
                  onChange={e => {
                    const eid = Number(e.target.value);
                    const exam = exams.find(ex => ex.id === eid) ?? null;
                    loadByExam(exam?.id ?? null, exam?.name ?? null);
                  }}
                  style={{ width: '100%', padding: '7px 32px 7px 12px', borderRadius: 9, border: '1.5px solid #E5E7EB', fontSize: 14, fontFamily: 'inherit', outline: 'none', background: '#fff', appearance: 'none', cursor: 'pointer' }}
                >
                  <option value="">-- Chọn kỳ thi --</option>
                  {exams.map(e => (
                    <option key={e.id} value={e.id}>
                      {e.name}{e.subject ? ` · ${e.subject}` : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#9CA3AF' }} />
              </div>
              <button
                onClick={() => navigate('/app/exams')}
                style={{ border: '1.5px solid #E5E7EB', borderRadius: 9, padding: '7px 14px', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: '#6B7280', whiteSpace: 'nowrap' }}
              >
                + Tạo kỳ thi
              </button>
            </div>
          )}
          {/* Row 2: Lượt chấm filter — only shown when this exam has more than one grading session */}
          {hasBatch && multipleGradedAt && (
            <div className="results-filter-row" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="results-filter-label" style={{ fontSize: 13, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', minWidth: 76 }}>Lượt chấm:</span>
              <div className="results-filter-select" style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
                <select
                  value={selectedGradedAt}
                  onChange={e => setSelectedGradedAt(e.target.value)}
                  style={{ width: '100%', padding: '7px 32px 7px 12px', borderRadius: 9, border: '1.5px solid #E5E7EB', fontSize: 14, fontFamily: 'inherit', outline: 'none', background: '#fff', appearance: 'none', cursor: 'pointer' }}
                >
                  <option value="all">Tất cả lượt chấm ({safeResults.length})</option>
                  {gradedAtOptions.map(([iso, count, source]) => (
                    <option key={iso} value={iso}>
                      {formatGradedAtLabel(iso)} · {source} · {count} phiếu
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#9CA3AF' }} />
              </div>
            </div>
          )}
          {/* Row 3: Template filter — always show when batch exists */}
          {hasBatch && (
            <div className="results-filter-row" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="results-filter-label" style={{ fontSize: 13, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', minWidth: 76 }}>Mẫu phiếu:</span>
              <div className="results-filter-select" style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
                <select
                  value={selectedTemplateKey}
                  onChange={e => setSelectedTemplateKey(e.target.value)}
                  style={{ width: '100%', padding: '7px 32px 7px 12px', borderRadius: 9, border: `1.5px solid ${isAllMode && multipleTemplates ? '#FCD34D' : '#E5E7EB'}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', background: '#fff', appearance: 'none', cursor: 'pointer' }}
                >
                  <option value="all">Tất cả mẫu phiếu ({gradedAtFilteredRows.length})</option>
                  {templateOptions.map(opt => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label} ({gradedAtFilteredRows.filter(({ r }) => getRowTemplateKey(r, batch) === opt.key).length})
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#9CA3AF' }} />
              </div>
              {isAllMode && multipleTemplates && (
                <span style={{ fontSize: 11, color: '#C8102E', background: '#FEF2F2', border: '1px solid #F3B4BC', borderRadius: 7, padding: '3px 10px', whiteSpace: 'nowrap' }}>
                  ⚠ Chọn 1 mẫu để xuất Excel/CSV
                </span>
              )}
            </div>
          )}
        </div>

        {/* DB save status banner — only relevant when results are loaded */}
        {hasBatch && <DbStatusBanner status={dbSaveStatus} />}

        {/* Export success toast */}
        {exportToast && (
          <div style={{ ...NEUTRAL_BANNER, borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <CheckCircle2 size={14} /> Đã xuất file Excel thành công.
          </div>
        )}

        {/* Batch info banner — only when real results exist */}
        {hasBatch && (
          <div style={{ ...NEUTRAL_BANNER, borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <CheckCircle2 size={18} style={{ flexShrink: 0, color: '#374151' }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {selectedExamName
                  ? <>Kỳ thi: <span style={{ color: '#C8102E' }}>{selectedExamName}</span> · {getBatchTemplateLabel(batch!)}</>
                  : <>Đợt chấm: {batch ? getBatchTemplateLabel(batch) : '—'}</>
                }
              </div>
              <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
                {totalSheets} phiếu · Chấm lúc: {!isAllGradedAt ? fmtDate(selectedGradedAt) : batch?.gradedAt ? fmtDate(batch.gradedAt) : '—'}
                {warnCount > 0 && (
                  <span style={{ color: '#C8102E', marginLeft: 10, fontWeight: 600 }}>
                    · <AlertTriangle size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> {warnCount} phiếu cần xem lại
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {hasBatch && (
          <Button variant="primary" icon={<Download size={16} />} loading={bundling} onClick={() => { void downloadBundle(); }}
            style={{ alignSelf: 'flex-start' }}>
            Tải tất cả (Excel + ảnh)
          </Button>
        )}
        {pageNotice && (
          <div style={{ fontSize: 13, borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8,
            background: pageNotice.ok ? '#ECFDF5' : '#FEF2F2', color: pageNotice.ok ? '#065F46' : '#B91C1C',
            border: `1px solid ${pageNotice.ok ? '#A7F3D0' : '#FECACA'}` }}>
            <span style={{ flex: 1 }}>{pageNotice.text}</span>
            <button type="button" onClick={() => setPageNotice(null)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', display: 'flex' }}><X size={14} /></button>
          </div>
        )}

        {/* Custom template schema missing warning */}
        {hasBatch && schemaMissing && (
          <div style={{ ...ALERT_BANNER, borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={16} style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 13 }}>
              Schema của custom template <strong>{batch.customTemplateName ?? `#${batch.customTemplateId}`}</strong> không có trong batch này.
              Các cột thông tin và đáp án có thể không hiển thị đúng.
              Để chấm lại với schema đúng, vui lòng quay lại Upload và chọn lại template.
            </span>
          </div>
        )}

        {/* No answer key warning */}
        {hasBatch && !hasKey && (
          <div style={{ ...ALERT_BANNER, borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <Key size={16} />
              <span>Chưa có Answer Key — kết quả hiện chỉ là đáp án nhận dạng, chưa tính điểm.</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => navigate('/app/answer-key')}
              style={{ whiteSpace: 'nowrap' }}>
              Nhập Answer Key →
            </Button>
          </div>
        )}

        {/* Summary cards — only when results exist */}
        {hasBatch && (
          <div className="results-stat-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${hasKey ? 7 : 4}, 1fr)`, gap: 12 }}>
            {[
              { label: 'Tổng phiếu',  value: String(totalSheets), sub: 'Đã xử lý' },
              { label: 'Cần xem lại', value: String(warnCount),   sub: 'Trước khi export' },
              { label: 'Template', value: isAllMode ? 'Tất cả' : (selectedTemplateOpt?.templateMode === 'custom' ? 'Custom' : 'VJU'), sub: isAllMode ? `${templateOptions.length} mẫu phiếu` : (selectedTemplateOpt?.label ?? '—'), small: true },
              ...(hasKey ? [
                { label: 'Phiếu có điểm', value: String(scores.length), sub: `/ ${totalSheets} phiếu` },
                { label: 'Điểm TB',   value: avgScore !== null ? String(avgScore) : '—', sub: 'Trung bình' },
                { label: 'Cao nhất',  value: maxScore !== null ? String(maxScore) : '—', sub: 'Max score' },
                { label: 'Thấp nhất', value: minScore !== null ? String(minScore) : '—', sub: 'Min score' },
              ] : [
                { label: 'Số câu', value: '60', sub: 'Theo template VJU' },
              ]),
            ].map((s, i) => (
              <Card key={i} style={{ borderTop: '3px solid #C8102E' }}>
                <div className="results-stat-label" style={{ fontSize: 10, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{s.label}</div>
                <div className="results-stat-value" style={{ fontSize: (s as { small?: boolean }).small ? 18 : 26, fontWeight: 800, color: '#1E1E1E' }}>{s.value}</div>
                <div className="results-stat-sub" style={{ fontSize: 11, color: '#9CA3AF', marginTop: 3 }}>{s.sub}</div>
              </Card>
            ))}
          </div>
        )}

        {/* Warning banner */}
        {warnCount > 0 && !reviewOnly && (
          <div style={{ ...ALERT_BANNER, borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flex: '1 1 200px', minWidth: 0 }}>
              <AlertTriangle size={16} style={{ flexShrink: 0 }} />
              <span><strong>{warnCount} phiếu có cảnh báo</strong> — kiểm tra trước khi tải Excel!</span>
            </div>
            <Button size="sm" variant="outline" onClick={startReview}>Kiểm tra ngay →</Button>
          </div>
        )}

        {/* Review-only filter indicator — 2026-07-31: replaces the old
           "Kiểm tra lỗi" separate page; sửa trực tiếp ngay trong bảng này.
           2026-07-31: nút "Xem tất cả" ở header (thay chỗ "Kiểm tra lỗi")
           không đủ nổi bật — "để ở trên cùng thì ai mà thấy" — nên thêm lại
           nút ngay trong dải cảnh báo đỏ này, đúng chỗ mắt đang nhìn vào lúc
           đang lọc. Header vẫn giữ nút toggle làm lối thoát dự phòng. */}
        {reviewOnly && (
          <div style={{ ...ALERT_BANNER, borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <AlertTriangle size={16} />
              Đang chỉ hiện <strong>{warnCount} phiếu cần xem lại</strong> — click hàng để sửa trực tiếp.
            </div>
            <Button size="sm" variant="outline" icon={<X size={13} />} onClick={() => setReviewOnly(false)}>Xem tất cả</Button>
          </div>
        )}

        {/* Bulk-action bar — 2026-07-31: "để action hàng loạt nhé, ví dụ a
           muốn xóa vẫn phải xóa từng cái" — select rows via the checkbox
           column and delete them all in one go instead of one confirm per row. */}
        {/* 2026-10-06: on phones this bar sits fixed at the bottom of the
            screen (.results-bulk-bar) — it used to stay at the top of the
            list, out of sight of the cards being ticked further down */}
        {selectedKeys.size > 0 && (
          <div className="results-bulk-bar" style={{ ...ALERT_BANNER, borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <CheckCircle2 size={16} />
              Đã chọn <strong>{selectedKeys.size} phiếu</strong>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button size="sm" variant="outline" onClick={() => setSelectedKeys(new Set())}>Bỏ chọn</Button>
              <Button size="sm" variant="outline" icon={<Download size={13} />} loading={savingImages}
                onClick={() => { void downloadImages(safeResults.filter(r => selectedKeys.has(rowKey(r)))); }}>Tải ảnh</Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => { void handleBulkDelete(); }}>Xoá đã chọn</Button>
            </div>
          </div>
        )}

        {/* Results table or empty state */}
        {hasBatch ? (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div className="results-table-toolbar" style={{ padding: '14px 16px', fontSize: 12, color: '#6B7280', display: 'flex', alignItems: 'center', gap: 8 }}>
              👆 Click hàng để xem chi tiết
              {batch && (
                <Badge
                  style={{ background: '#F3F4F6', color: '#374151', borderRadius: 9999, padding: '2px 10px', fontSize: 11, fontWeight: 600 }}
                >
                  {getBatchTemplateLabel(batch)}
                </Badge>
              )}
              <div className="results-table-toolbar-spacer" style={{ flex: 1 }} />
              {/* 2026-08-04: "cũng ko thấy có bộ lọc theo msv hay sbd ở đây" —
                 quick find-a-student box; matches filename + any info field
                 value (CCCD/SBD/MSV/Mã đề/...) on the currently-shown rows.
                 Purely a display convenience — doesn't affect stats/export
                 above, which stay scoped to the exam/lượt chấm/mẫu phiếu
                 filters exactly as before. */}
              <div className="results-search-box" style={{ position: 'relative', width: 220 }}>
                <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#9CA3AF' }} />
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Tìm theo MSV, SBD, CCCD..."
                  style={{ width: '100%', padding: '6px 10px 6px 28px', borderRadius: 8, border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'inherit', outline: 'none' }}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    title="Xoá tìm kiếm"
                    style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: '#9CA3AF', display: 'flex' }}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
            {reviewOnly && visibleScoredRows.length === 0 ? (
              <div style={{ padding: '48px 24px', textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>✅</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#065F46', marginBottom: 4 }}>Không còn phiếu nào cần xem lại</div>
                <Button size="sm" variant="outline" icon={<X size={13} />} onClick={() => setReviewOnly(false)} style={{ marginTop: 10 }}>Xem tất cả</Button>
              </div>
            ) : searchQuery.trim() && searchedRows.length === 0 ? (
              <div style={{ padding: '48px 24px', textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>🔍</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Không tìm thấy phiếu nào khớp "{searchQuery}"</div>
                <Button size="sm" variant="outline" icon={<X size={13} />} onClick={() => setSearchQuery('')} style={{ marginTop: 10 }}>Xoá tìm kiếm</Button>
              </div>
            ) : (
            <>
            {/* phones: one card per phiếu (see RealCard); the table below is hidden there */}
            <div className="results-cards" style={{ flexDirection: 'column', gap: 10, padding: `4px 0 ${selectedKeys.size > 0 ? 110 : 8}px` }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#6B7280', padding: '0 2px' }}>
                <input type="checkbox"
                  checked={searchedRows.length > 0 && searchedRows.every(({ r }) => selectedKeys.has(rowKey(r)))}
                  onChange={toggleSelectAllVisible} style={{ accentColor: '#C8102E', width: 16, height: 16 }} />
                Chọn tất cả · bấm vào phiếu để xem chi tiết, sửa
              </label>
              {/* the page-header buttons are off-screen on a phone: the two
                  that matter here, right above the cards */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button size="sm" variant="outline" icon={<Download size={13} />} loading={savingImages}
                  onClick={() => { void downloadImages(searchedRows.map(x => x.r)); }}>
                  Tải ảnh ({searchedRows.length})
                </Button>
                <Button size="sm" variant="secondary" icon={<Trash2 size={13} />} onClick={() => { void handleClear(); }}
                  style={{ color: '#EF4444', borderColor: '#FECACA' }}>
                  Xoá tất cả
                </Button>
              </div>
              {searchedRows.map(({ r, merged, corr, sc, missingKeyForMaDe, maDeValue, proctors }, i) => (
                <RealCard
                  key={r.db_id ?? r.input?.filename ?? i}
                  idx={i + 1} r={r} merged={merged} corrected={correctionHasChanges(corr, r, resolveRowSchema(r).infoFields)} sc={sc}
                  identityFields={(isAllMode ? resolveRowSchema(r).infoFields : activeInfoFields).slice(0, 2)}
                  missingKeyForMaDe={missingKeyForMaDe}
                  maDeValue={maDeValue}
                  proctors={proctors}
                  onOpen={() => setModalRow(r)}
                  onDelete={() => { void handleDeleteRow(r.input?.filename ?? '', r.db_id); }}
                  selected={selectedKeys.has(rowKey(r))}
                  onToggleSelect={() => toggleSelectRow(rowKey(r))}
                />
              ))}
            </div>
            <div className="results-table-wrap" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#C8102E' }}>
                    <th style={{ padding: '10px 10px', width: 32 }}>
                      <input
                        type="checkbox"
                        checked={searchedRows.length > 0 && searchedRows.every(({ r }) => selectedKeys.has(rowKey(r)))}
                        onChange={toggleSelectAllVisible}
                        title="Chọn tất cả"
                        style={{ accentColor: '#fff', width: 15, height: 15, cursor: 'pointer' }}
                      />
                    </th>
                    {['STT', 'File', 'Họ tên / Ngày sinh',
                      // 2026-08-04: "cái này ko có mssv hay sbd à? (theo tuỳ
                      // phiếu ấy)" — in "Tất cả mẫu phiếu" mode, rows can come
                      // from different templates with different info fields,
                      // so there's no single fixed column that fits every
                      // row — add one generic "Mã định danh" column instead,
                      // showing each row's own first identifying field(s) —
                      // see RealRow's showTemplateCol branch below.
                      ...(isAllMode ? ['Mã định danh', 'Mẫu phiếu'] : activeInfoFields.map(f => f.displayName)),
                      ...(hasKey ? ['Đúng','Sai','Trống','Điểm'] : []),
                      'Thao tác',
                    ].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '10px 10px', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {searchedRows.map(({ r, merged, corr, sc, missingKeyForMaDe, maDeValue, proctors }, i) => (
                    <RealRow
                      key={r.db_id ?? r.input?.filename ?? i}
                      idx={i + 1} r={r} merged={merged} corrected={correctionHasChanges(corr, r, resolveRowSchema(r).infoFields)} sc={sc}
                      rowIdentityFields={isAllMode ? resolveRowSchema(r).infoFields.slice(0, 2) : undefined}
                      missingKeyForMaDe={missingKeyForMaDe}
                      maDeValue={maDeValue}
                      proctors={proctors}
                      onOpen={() => setModalRow(r)}
                      onDelete={() => { void handleDeleteRow(r.input?.filename ?? '', r.db_id); }}
                      infoFields={activeInfoFields}
                      showTemplateCol={isAllMode}
                      templateLabel={getRowTemplateLabel(r, batch, fetchedTemplateNames)}
                      selected={selectedKeys.has(rowKey(r))}
                      onToggleSelect={() => toggleSelectRow(rowKey(r))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            </>
            )}
          </Card>
        ) : dataSource !== 'init' ? (
          /* Empty state — shown after delete-all or when DB+localStorage are both empty */
          <Card style={{ padding: '64px 32px', textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#1E1E1E', marginBottom: 8 }}>
              {selectedExamName
                ? <>Kỳ thi <span style={{ color: '#C8102E' }}>"{selectedExamName}"</span> chưa có kết quả chấm</>
                : 'Chưa có kết quả chấm'
              }
            </div>
            <div style={{ fontSize: 14, color: '#6B7280', marginBottom: 24 }}>
              {selectedExamName
                ? 'Vào Upload & Chấm phiếu, chọn đúng kỳ thi này để chấm.'
                : 'Hãy vào Upload & Chấm để chấm phiếu trước.'
              }
            </div>
            <Button variant="primary" icon={<ArrowLeft size={14} />} onClick={() => navigate('/app/upload')}>
              Quay lại Upload
            </Button>
          </Card>
        ) : null}
      </div>

      {confirmDialog}

      {modalRow && (
        <ResultDetailModal
          r={modalRow}
          correction={corrections[correctionKey(batch?.gradedAt, modalRow.input?.filename ?? '')]}
          answerKey={answerKey}
          onClose={() => setModalRow(null)}
          templateSchema={resolveRowSchema(modalRow)}
          onSaveCorrection={handleSaveCorrection}
          onResetCorrection={handleResetCorrection}
        />
      )}

      {showExcelPreview && batch && (
        <ExcelPreviewModal
          batch={{ ...batch, templateSchema: selectedTemplateOpt?.templateSchema ?? batch.templateSchema }}
          results={visibleScoredRows.map(x => x.r)}
          answerKey={answerKey}
          corrections={corrections}
          dataSource={dataSource === 'db' ? 'Database' : 'Trình duyệt (localStorage)'}
          onClose={() => setShowExcelPreview(false)}
          onSuccess={() => {
            setExportToast(true);
            setTimeout(() => setExportToast(false), 3500);
          }}
        />
      )}
    </div>
  );
}
