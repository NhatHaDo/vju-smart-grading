import { useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback, useRef } from 'react';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Badge from '../components/common/Badge';
import PageHeader from '../components/layout/PageHeader';
import { Download, Eye, AlertTriangle, CheckCircle2, Trash2, ArrowLeft, Key, Database, WifiOff, TableProperties, ChevronDown } from 'lucide-react';
import type { BatchGradeState, OmrGradeResult, AnswerKeyStore, CorrectionsStore, InfoFieldColumns, TemplateSchema } from '../types/grading';
import { TEMPLATE_VARIANT_LABEL, VJU_PRESET_SCHEMA, loadAnswerKey, loadCorrections, saveCorrections, clearCorrections, computeScore, applyCorrection } from '../types/grading';
import ResultDetailModal from '../components/results/ResultDetailModal';
import ExcelPreviewModal from '../components/results/ExcelPreviewModal';
import { resultsApi, examsApi, customFormsApi, hasToken, ApiError, type BatchResultOut, type ResultBatchSaveRequest } from '../services/apiClient';
import { buildSchemaFromDetail } from '../utils/templateSchema';
import type { ExamOut } from '../types/exam';

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

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function dbRowToOmrResult(row: BatchResultOut): OmrGradeResult & { db_id: number } {
  const debugPaths = parseJson<Record<string, string | null>>(row.debug_paths_json, {});
  return {
    db_id:               row.id,
    template_type:       row.template_type,
    template_id:         row.template_id,
    template_variant_row: row.template_variant,
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

// ── Template label helper ──────────────────────────────────────────────────

function getBatchTemplateLabel(b: BatchGradeState): string {
  if (b.templateMode === 'custom') {
    return b.customTemplateName ? `Custom template — ${b.customTemplateName}` : 'Custom template';
  }
  return TEMPLATE_VARIANT_LABEL[b.templateVariant] ?? b.templateVariant;
}

// ── Template filter helpers ────────────────────────────────────────────────

type TemplateFilterOption = {
  key:           string;
  label:         string;
  templateMode:  'vju' | 'custom';
  templateId?:   number | null;
  templateSchema: TemplateSchema;
};

function getRowTemplateKey(r: OmrGradeResult, fallbackBatch?: BatchGradeState | null): string {
  const ttype = r.template_type ?? (fallbackBatch?.templateMode === 'custom' ? 'custom' : 'vju');
  if (ttype === 'custom') {
    const tid = r.template_id ?? fallbackBatch?.customTemplateId ?? null;
    return `custom:${tid ?? 'unknown'}`;
  }
  const tvar = r.template_variant_row ?? fallbackBatch?.templateVariant ?? 'sbd8';
  return `vju:${tvar}`;
}

function getRowTemplateLabel(r: OmrGradeResult, fallbackBatch?: BatchGradeState | null): string {
  const key = getRowTemplateKey(r, fallbackBatch);
  if (key.startsWith('custom:')) {
    const name = fallbackBatch?.customTemplateName ?? null;
    return name ? `Custom - ${name}` : `Custom #${r.template_id ?? fallbackBatch?.customTemplateId ?? '?'}`;
  }
  const tvar = r.template_variant_row ?? fallbackBatch?.templateVariant ?? 'sbd8';
  return TEMPLATE_VARIANT_LABEL[tvar as keyof typeof TEMPLATE_VARIANT_LABEL] ?? tvar.toUpperCase();
}

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
        debug_paths: {
          overlay_all_path:         r.debug?.overlay_all_path         ?? null,
          overlay_marked_only_path: r.debug?.overlay_marked_only_path ?? null,
          overlay_warnings_path:    r.debug?.overlay_warnings_path    ?? null,
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
    const sc = answerKey ? computeScore(r.answers ?? {}, answerKey) : null;
    return [
      r.input?.filename ?? '',
      r._error ? 'error' : 'ok',
      getRowTemplateLabel(r, batch),
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
function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleString('vi-VN', { hour12: false }); } catch { return iso; }
}

// ── RealRow ────────────────────────────────────────────────────────────────

function RealRow({ idx, r, merged, corrected, sc, onOpen, onDelete, infoFields, showTemplateCol, templateLabel }: {
  idx:             number;
  r:               OmrGradeResult;
  merged:          { student_info: OmrGradeResult['student_info']; answers: Record<string, string | null> };
  corrected:       boolean;
  sc:              { correct: number; wrong: number; blank: number; total: number } | null;
  onOpen:          () => void;
  onDelete:        () => void;
  infoFields:      import('../types/grading').TemplateInfoField[];
  showTemplateCol?: boolean;
  templateLabel?:  string;
}) {
  const warn   = hasWarnings(r);
  const hasIMM = hasInfoMultiMark(r);
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
      style={{ borderBottom: '1px solid #F3F4F6', background: warn ? '#FFF9F9' : corrected ? '#F0FDF4' : '#fff', cursor: 'pointer' }}
    >
      <td style={{ padding: '11px 10px', color: '#9CA3AF' }}>{idx}</td>
      <td style={{ padding: '11px 10px' }}>
        <div style={{ fontWeight: 600, color: '#1E1E1E', display: 'flex', alignItems: 'center', gap: 4 }}>
          {r.input?.filename ?? '—'}
          {warn && !hasIMM && <AlertTriangle size={12} color="#FCB900" title="Có cảnh báo MCQ" />}
          {hasIMM && <AlertTriangle size={12} color="#CA8A04" title={buildInfoWarningsCsv(r) || 'Có nhiều ô tô trong cột thông tin'} />}
          {r._error && <span style={{ fontSize: 10, color: '#EF4444', fontWeight: 400 }}>ERR</span>}
          {corrected && <span style={{ fontSize: 10, color: '#10B981', fontWeight: 700, background: '#D1FAE5', borderRadius: 4, padding: '1px 5px' }}>Đã sửa tay</span>}
          {r.db_id && <span style={{ fontSize: 9, color: '#6366F1', background: '#EEF2FF', borderRadius: 4, padding: '1px 5px' }}>DB</span>}
        </div>
        {r._error && <div style={{ fontSize: 10, color: '#EF4444', marginTop: 2 }}>{r._error.slice(0, 80)}</div>}
      </td>
      {showTemplateCol
        ? <td style={{ padding: '11px 10px', fontSize: 11 }}>
            <span style={{ background: '#EFF6FF', color: '#1D4ED8', borderRadius: 9999, padding: '2px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {templateLabel ?? '—'}
            </span>
          </td>
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
      {sc !== null && <>
        <td style={{ padding: '11px 10px', color: '#065F46', fontWeight: 600 }}>{sc.correct}</td>
        <td style={{ padding: '11px 10px', color: '#991B1B', fontWeight: 600 }}>{sc.wrong}</td>
        <td style={{ padding: '11px 10px', color: '#6B7280' }}>{sc.blank}</td>
        <td style={{ padding: '11px 10px', fontWeight: 800, color: '#1E1E1E', fontSize: 13 }}>{sc.total}</td>
      </>}
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

// ── DB Save status banner ──────────────────────────────────────────────────

type DbSaveStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'auth_failed';
type DataSource   = 'init' | 'db' | 'localStorage';

function DbStatusBanner({ status }: { status: DbSaveStatus }) {
  if (status === 'idle') return null;
  if (status === 'saving') return (
    <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#1D4ED8' }}>
      <Database size={14} /> Đang lưu kết quả vào database…
    </div>
  );
  if (status === 'saved') return (
    <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#065F46' }}>
      <Database size={14} /> Đã lưu kết quả vào database
    </div>
  );
  if (status === 'auth_failed') return (
    <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#991B1B' }}>
      <WifiOff size={14} /> Phiên đăng nhập đã hết hạn — kết quả chưa được lưu vào database. Vui lòng đăng nhập lại.
    </div>
  );
  return (
    <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#92400E' }}>
      <WifiOff size={14} /> Không lưu được database — kết quả đang giữ tạm trong trình duyệt
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
  const [exportToast,       setExportToast]       = useState(false);
  const [showExcelPreview,  setShowExcelPreview]  = useState(false);
  const [dataSource,    setDataSource]     = useState<DataSource>('init');
  const [dbSaveStatus,  setDbSaveStatus]   = useState<DbSaveStatus>('idle');

  // ── Exam + template filter context ───────────────────────────────────────
  const [selectedExamId,      setSelectedExamId]      = useState<number | null>(null);
  const [selectedExamName,    setSelectedExamName]    = useState<string | null>(null);
  const [exams,               setExams]               = useState<ExamOut[]>([]);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>('all');

  // Schema cache for custom templates loaded from DB (which don't carry templateSchema)
  const [fetchedSchemas, setFetchedSchemas] = useState<Map<number, TemplateSchema>>(new Map());
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
          .then(detail => ({ id, schema: buildSchemaFromDetail(detail) }))
          .catch(() => null)
      )
    ).then(results => {
      const updates = results.filter(Boolean) as { id: number; schema: TemplateSchema }[];
      if (updates.length === 0) return;
      setFetchedSchemas(prev => {
        const next = new Map(prev);
        for (const { id, schema } of updates) next.set(id, schema);
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
    setBatch(null);
    setDataSource('init');
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

  const handleDeleteRow = (filename: string, db_id?: number) => {
    if (!window.confirm(`Xoá kết quả "${filename}"?`)) return;
    // DB delete (fire-and-forget)
    if (db_id) {
      resultsApi.deleteOne(db_id).catch(e => console.warn('[DB delete]', e));
    }
    setBatch(prev => {
      if (!prev) return prev;
      const newResults = prev.results.filter(r => r.input?.filename !== filename);
      if (newResults.length === 0) { clearStorage(); return null; }
      const updated = { ...prev, results: newResults };
      try { localStorage.setItem(LS_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
      return updated;
    });
    setCorrections(prev => {
      const next = { ...prev };
      delete next[filename];
      saveCorrections(next);
      return next;
    });
  };

  const handleClear = () => {
    const examLabel = selectedExamName ? `"${selectedExamName}"` : 'kỳ thi này';
    if (!window.confirm(`Xoá tất cả kết quả của ${examLabel}? Hành động này không thể hoàn tác.`)) return;
    // DB clear: filter by exam_id when known
    const shouldClearDb = dataSource === 'db' || (batch?.results ?? []).some(r => r.db_id);
    if (shouldClearDb) {
      const params = selectedExamId !== null ? { exam_id: selectedExamId } : undefined;
      resultsApi.deleteAll(params).catch(e => console.warn('[DB deleteAll]', e));
    }
    clearStorage();
    try { localStorage.removeItem('vju_pending_grade'); } catch { /* ignore */ }
    setBatch(null);
    clearCorrections();
    setCorrections({});
    setDataSource('localStorage');
    setDbSaveStatus('idle');
    savedBatchKeyRef.current = null;
  };

  // ── Derived state ──────────────────────────────────────────────────────

  const safeResults = batch?.results && Array.isArray(batch.results) ? batch.results : [];
  const hasBatch    = safeResults.length > 0;
  const hasKey      = !!answerKey && Object.keys(answerKey.answers ?? {}).length > 0;

  // Build template options from all rows in the current exam
  const templateOptions: TemplateFilterOption[] = (() => {
    const seen = new Map<string, TemplateFilterOption>();
    for (const r of safeResults) {
      const key = getRowTemplateKey(r, batch);
      if (!seen.has(key)) {
        const isCustom = key.startsWith('custom:');
        const tid = isCustom ? (r.template_id ?? batch?.customTemplateId ?? null) : null;
        const schema: TemplateSchema = isCustom
          ? (batch?.templateSchema && batch.customTemplateId === tid
              ? batch.templateSchema
              : (tid != null && fetchedSchemas.has(tid)
                  ? fetchedSchemas.get(tid)!
                  : { infoFields: [], answerSections: [] }))
          : VJU_PRESET_SCHEMA;
        seen.set(key, {
          key,
          label:         getRowTemplateLabel(r, batch),
          templateMode:  isCustom ? 'custom' : 'vju',
          templateId:    tid,
          templateSchema: schema,
        });
      }
    }
    return Array.from(seen.values());
  })();

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
    const corr     = corrections[filename];
    const merged   = applyCorrection(r, corr);
    return { r, merged, corr, sc: hasKey ? computeScore(merged.answers ?? {}, answerKey!) : null };
  });

  // Rows visible after template filter
  const visibleScoredRows = isAllMode
    ? allScoredRows
    : allScoredRows.filter(({ r }) => getRowTemplateKey(r, batch) === selectedTemplateKey);

  const scores      = visibleScoredRows.map(x => x.sc?.total ?? null).filter((s): s is number => s !== null);
  const avgScore    = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null;
  const maxScore    = scores.length ? Math.max(...scores) : null;
  const minScore    = scores.length ? Math.min(...scores) : null;
  const warnCount   = visibleScoredRows.filter(({ r }) => hasWarnings(r)).length;
  const totalSheets = visibleScoredRows.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title={selectedExamName ? `Kết quả: ${selectedExamName}` : 'Kết quả & Export'}
        subtitle="Xem điểm, ảnh detect, tải CSV và chấm lại khi cần"
        actions={<>
          <Button variant="secondary" size="sm" icon={<ArrowLeft size={14} />} onClick={() => navigate('/app/upload')}>Quay lại Upload</Button>
          {hasBatch && (
            <Button variant="secondary" size="sm" icon={<AlertTriangle size={14} />}
              onClick={() => navigate('/app/review-errors', {
                state: {
                  examId:         selectedExamId,
                  templateKey:    selectedTemplateKey,
                  templateSchema: selectedTemplateOpt?.templateSchema ?? null,
                }
              })}>
              Kiểm tra lỗi
            </Button>
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
            variant="secondary" size="sm" icon={<Download size={14} />}
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
                exportCsv(batch, answerKey, visibleScoredRows.map(x => x.r), selectedTemplateOpt?.label);
              }}>
              Xuất CSV
            </Button>
          )}
          {hasBatch && (
            <Button variant="secondary" size="sm" icon={<Trash2 size={14} />} onClick={handleClear}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', minWidth: 76 }}>Kỳ thi:</span>
              <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
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
          {/* Row 2: Template filter — always show when batch exists */}
          {hasBatch && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', minWidth: 76 }}>Mẫu phiếu:</span>
              <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
                <select
                  value={selectedTemplateKey}
                  onChange={e => setSelectedTemplateKey(e.target.value)}
                  style={{ width: '100%', padding: '7px 32px 7px 12px', borderRadius: 9, border: `1.5px solid ${isAllMode && multipleTemplates ? '#FCD34D' : '#E5E7EB'}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', background: '#fff', appearance: 'none', cursor: 'pointer' }}
                >
                  <option value="all">Tất cả mẫu phiếu ({safeResults.length})</option>
                  {templateOptions.map(opt => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label} ({allScoredRows.filter(({ r }) => getRowTemplateKey(r, batch) === opt.key).length})
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#9CA3AF' }} />
              </div>
              {isAllMode && multipleTemplates && (
                <span style={{ fontSize: 11, color: '#B45309', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 7, padding: '3px 10px', whiteSpace: 'nowrap' }}>
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
          <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#065F46' }}>
            <CheckCircle2 size={14} /> Đã xuất file Excel thành công.
          </div>
        )}

        {/* Data source indicator */}
        {dataSource === 'db' && hasBatch && (
          <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#1D4ED8' }}>
            <Database size={14} /> Đang hiển thị kết quả đã lưu ({safeResults.length} phiếu)
          </div>
        )}

        {/* Batch info banner — only when real results exist */}
        {hasBatch && (
          <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <CheckCircle2 size={18} color="#10B981" style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#065F46' }}>
                {selectedExamName
                  ? <>Kỳ thi: <span style={{ color: '#C8102E' }}>{selectedExamName}</span> · {getBatchTemplateLabel(batch!)}</>
                  : <>Đợt chấm: {batch ? getBatchTemplateLabel(batch) : '—'}</>
                }
              </div>
              <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
                {totalSheets} phiếu · Chấm lúc: {batch?.gradedAt ? fmtDate(batch.gradedAt) : '—'}
                {warnCount > 0 && (
                  <span style={{ color: '#B45309', marginLeft: 10 }}>
                    · <AlertTriangle size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> {warnCount} phiếu cần xem lại
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Custom template schema missing warning */}
        {hasBatch && schemaMissing && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={16} color="#EF4444" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: '#991B1B' }}>
              Schema của custom template <strong>{batch.customTemplateName ?? `#${batch.customTemplateId}`}</strong> không có trong batch này.
              Các cột thông tin và đáp án có thể không hiển thị đúng.
              Để chấm lại với schema đúng, vui lòng quay lại Upload và chọn lại template.
            </span>
          </div>
        )}

        {/* No answer key warning */}
        {hasBatch && !hasKey && (
          <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#92400E' }}>
              <Key size={16} />
              <span>Chưa có Answer Key — kết quả hiện chỉ là đáp án nhận dạng, chưa tính điểm.</span>
            </div>
            <Button size="sm" variant="secondary" onClick={() => navigate('/app/answer-key')}
              style={{ color: '#92400E', borderColor: '#FED7AA', whiteSpace: 'nowrap' }}>
              Nhập Answer Key →
            </Button>
          </div>
        )}

        {/* Summary cards — only when results exist */}
        {hasBatch && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${hasKey ? 7 : 4}, 1fr)`, gap: 12 }}>
            {[
              { label: 'Tổng phiếu',  value: String(totalSheets), sub: 'Đã xử lý' },
              { label: 'Cần xem lại', value: String(warnCount),   sub: 'Trước khi export', accent: '#FCB900' },
              { label: 'Template', value: isAllMode ? 'Tất cả' : (selectedTemplateOpt?.templateMode === 'custom' ? 'Custom' : 'VJU'), sub: isAllMode ? `${templateOptions.length} mẫu phiếu` : (selectedTemplateOpt?.label ?? '—'), small: true },
              ...(hasKey ? [
                { label: 'Phiếu có điểm', value: String(scores.length), sub: `/ ${totalSheets} phiếu`, accent: '#6366F1' },
                { label: 'Điểm TB',   value: avgScore !== null ? String(avgScore) : '—', sub: 'Trung bình', accent: '#10B981' },
                { label: 'Cao nhất',  value: maxScore !== null ? String(maxScore) : '—', sub: 'Max score',  accent: '#2563EB' },
                { label: 'Thấp nhất', value: minScore !== null ? String(minScore) : '—', sub: 'Min score',  accent: '#EF4444' },
              ] : [
                { label: 'Số câu', value: '60', sub: 'Theo template VJU' },
              ]),
            ].map((s, i) => (
              <Card key={i} style={{ borderTop: `3px solid ${(s as { accent?: string }).accent ?? '#C8102E'}` }}>
                <div style={{ fontSize: 10, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontSize: (s as { small?: boolean }).small ? 18 : 26, fontWeight: 800, color: '#1E1E1E' }}>{s.value}</div>
                <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 3 }}>{s.sub}</div>
              </Card>
            ))}
          </div>
        )}

        {/* Warning banner */}
        {warnCount > 0 && (
          <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#92400E' }}>
              <AlertTriangle size={16} />
              <strong>{warnCount} phiếu có cảnh báo</strong> — kiểm tra trước khi tải Excel!
            </div>
            <Button size="sm" variant="secondary" onClick={() => navigate('/app/review-errors', { state: { examId: selectedExamId, templateKey: selectedTemplateKey, templateSchema: selectedTemplateOpt?.templateSchema ?? null } })}>Kiểm tra ngay →</Button>
          </div>
        )}

        {/* Results table or empty state */}
        {hasBatch ? (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', fontSize: 12, color: '#6B7280', display: 'flex', alignItems: 'center', gap: 8 }}>
              👆 Click hàng để xem chi tiết
              {batch && (
                <Badge
                  label={getBatchTemplateLabel(batch)}
                  style={{ background: '#EFF6FF', color: '#1D4ED8', borderRadius: 9999, padding: '2px 10px', fontSize: 11, fontWeight: 600 }}
                />
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#C8102E' }}>
                    {['STT', 'File',
                      ...(isAllMode ? ['Mẫu phiếu'] : activeInfoFields.map(f => f.displayName)),
                      ...(hasKey ? ['Đúng','Sai','Trống','Điểm'] : []),
                      'Thao tác',
                    ].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '10px 10px', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleScoredRows.map(({ r, merged, corr, sc }, i) => (
                    <RealRow
                      key={r.db_id ?? r.input?.filename ?? i}
                      idx={i + 1} r={r} merged={merged} corrected={!!corr} sc={sc}
                      onOpen={() => setModalRow(r)}
                      onDelete={() => handleDeleteRow(r.input?.filename ?? '', r.db_id)}
                      infoFields={activeInfoFields}
                      showTemplateCol={isAllMode}
                      templateLabel={getRowTemplateLabel(r, batch)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
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

      {modalRow && (
        <ResultDetailModal
          r={modalRow}
          correction={corrections[modalRow.input?.filename ?? '']}
          answerKey={answerKey}
          onClose={() => setModalRow(null)}
          templateSchema={resolveRowSchema(modalRow)}
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
