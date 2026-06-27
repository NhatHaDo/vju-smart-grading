/**
 * ExcelPreviewPage.tsx
 * Route: /app/excel-preview
 *
 * Single pipeline:
 *   results + templateSchema
 *   → buildResultsWorkbook()   (workbookRef — mutable, edits persist)
 *   → buildWorkbookDisplay()   (display state — rebuilt after each edit)
 *   → WorkbookPreview renders from display
 *   → Export writes workbookRef.current (includes edits)
 *
 * UI: light "mock sáng" — white header, SAGE green toolbar, light tab bar.
 * No dark toolbar/tab bar.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Printer, ArrowLeft, FileSpreadsheet, AlertTriangle, RefreshCw, Edit3 } from 'lucide-react';
import WorkbookPreview from '../components/excel/WorkbookPreview';
import { buildResultsWorkbook, buildWorkbookDisplay } from '../utils/excelWorkbookBuilder';
import type { WorkbookDisplay } from '../utils/excelWorkbookBuilder';
import { saveAs } from 'file-saver';
import { dbRowToOmrResult } from '../utils/resultMapping';
import { resultsApi, customFormsApi } from '../services/apiClient';
import {
  loadAnswerKey, loadCorrections, TEMPLATE_VARIANT_LABEL,
} from '../types/grading';
import type {
  BatchGradeState, OmrGradeResult, AnswerKeyStore, CorrectionsStore, TemplateSchema,
} from '../types/grading';
import { buildSchemaFromDetail } from '../utils/templateSchema';

// ── Palette ───────────────────────────────────────────────────────────────────

const INK        = '#1a1a1a';
const INK_MUTED  = '#71717a';
const WASHI_BG   = '#f4f5f7';
const WASHI_CARD = '#ffffff';
const WASHI_BORDER = '#e5e7eb';
const SEAL_RED   = '#C8102E';
const SAGE       = '#1B5E20';
const SAGE_DARK  = '#145214';

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_KEY = 'vju_last_batch_grade';

const TABS = [
  { id: 'tong_quan',    label: 'Tổng quan',      sheetIdx: 0 },
  { id: 'bang_diem',    label: 'Bảng điểm',       sheetIdx: 1 },
  { id: 'can_kiem_tra', label: 'Cần kiểm tra',    sheetIdx: 2 },
  { id: 'chi_tiet',     label: 'Chi tiết đáp án', sheetIdx: 3 },
] as const;
type TabId = typeof TABS[number]['id'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadFromStorage(): BatchGradeState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BatchGradeState;
    if (!parsed?.templateVariant || !Array.isArray(parsed.results)) return null;
    return parsed;
  } catch { return null; }
}

function needsReview(r: OmrGradeResult): boolean {
  return (r.warnings ?? []).length > 0 || (r.score?.blank ?? 0) > 0 || !!r._error;
}

type LoadState = 'loading' | 'ok' | 'empty';

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ExcelPreviewPage() {
  const navigate = useNavigate();

  // ── Data state ─────────────────────────────────────────────────────────────
  const [loadState,   setLoadState]   = useState<LoadState>('loading');
  const [dataSource,  setDataSource]  = useState<'db' | 'localStorage'>('db');
  const [batch,       setBatch]       = useState<BatchGradeState | null>(null);
  const [answerKey,   setAnswerKey]   = useState<AnswerKeyStore | null>(null);
  const [corrections, setCorrections] = useState<CorrectionsStore>({});
  const [fetchedSchemas, setFetchedSchemas] = useState<Map<number, TemplateSchema>>(new Map());
  const fetchedSchemaIdsRef = useRef<Set<number>>(new Set());

  // ── UI state ───────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>('bang_diem');
  const [editMode,  setEditMode]  = useState(false);
  const [exporting, setExporting] = useState(false);

  // ── Workbook — stored in ref so edits survive re-renders ──────────────────
  const workbookRef = useRef<ReturnType<typeof buildResultsWorkbook> | null>(null);
  const [display, setDisplay] = useState<WorkbookDisplay | null>(null);

  // ── Load data ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoadState('loading');
    setAnswerKey(loadAnswerKey());
    setCorrections(loadCorrections());

    const lsBatch = loadFromStorage();
    const examId   = lsBatch?.examId   ?? null;
    const examName = lsBatch?.examName ?? null;

    try {
      const params: Parameters<typeof resultsApi.list>[0] = { limit: 500 };
      if (examId !== null) params.exam_id = examId;
      const resp = await resultsApi.list(params);
      if (resp.items.length > 0) {
        const converted = resp.items.map(dbRowToOmrResult);
        const first     = resp.items[0];
        setBatch({
          templateVariant: (first.template_variant as BatchGradeState['templateVariant']) ?? 'sbd8',
          results:  converted,
          gradedAt: first.graded_at,
          examId:   first.exam_id ?? examId,
          examName,
        });
        setDataSource('db');
        setLoadState('ok');
        return;
      }
    } catch { /* DB failed → try localStorage */ }

    if (lsBatch && lsBatch.results.length > 0) {
      setBatch(lsBatch);
      setDataSource('localStorage');
      setLoadState('ok');
      return;
    }

    setBatch(null);
    setLoadState('empty');
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Fetch schemas for custom template rows that have no schema in batch
  useEffect(() => {
    if (!batch) return;
    const safeR = Array.isArray(batch.results) ? batch.results : [];
    const missingIds: number[] = [];
    for (const r of safeR) {
      if (r.template_type === 'custom' && r.template_id != null) {
        const alreadyInBatch = batch.templateSchema != null && batch.customTemplateId === r.template_id;
        if (!alreadyInBatch && !fetchedSchemaIdsRef.current.has(r.template_id)) {
          fetchedSchemaIdsRef.current.add(r.template_id);
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
  }, [batch]);

  // ── Resolve effective schema ───────────────────────────────────────────────

  const safeResults = useMemo(() => batch?.results ?? [], [batch]);

  const templateSchema = useMemo((): TemplateSchema | null => {
    if (!batch) return null;
    if (batch.templateSchema) return batch.templateSchema;
    const safeR = Array.isArray(batch.results) ? batch.results : [];
    const customIds = new Set(
      safeR
        .filter(r => r.template_type === 'custom' && r.template_id != null)
        .map(r => r.template_id!)
    );
    if (customIds.size === 1) {
      const [id] = customIds;
      if (fetchedSchemas.has(id)) return fetchedSchemas.get(id)!;
    }
    return null;
  }, [batch, fetchedSchemas]);

  // ── Rebuild workbook when data changes ────────────────────────────────────

  useEffect(() => {
    if (!batch) {
      workbookRef.current = null;
      setDisplay(null);
      return;
    }
    const wb = buildResultsWorkbook({
      batch,
      results:         safeResults,
      answerKey,
      corrections,
      dataSource:      dataSource === 'db' ? 'Database' : 'Trình duyệt (localStorage)',
      examName:        batch.examName ?? null,
      includeReview:   true,
      includeAnswers:  true,
      highlightReview: true,
      templateSchema,
    });
    workbookRef.current = wb;
    setDisplay(buildWorkbookDisplay(wb));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, safeResults, answerKey, corrections, dataSource, templateSchema]);

  // ── Cell edit handler ──────────────────────────────────────────────────────

  function handleCellChange(sheetName: string, row: number, col: number, value: string) {
    const wb = workbookRef.current;
    if (!wb) return;
    const ws = wb.getWorksheet(sheetName);
    if (!ws) return;
    ws.getCell(row, col).value = value;
    setDisplay(buildWorkbookDisplay(wb));
  }

  // ── Export — uses workbookRef (includes edits) ────────────────────────────

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts  = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const examName  = batch?.examName ?? null;
  const examSlug  = examName
    ? '_' + examName.replace(/[^a-zA-Z0-9À-ỹ]/g, '_').replace(/_+/g, '_').slice(0, 30)
    : '';
  const filename = `vju_smart_grading${examSlug}_${ts}.xlsx`;

  async function handleDownload() {
    const wb = workbookRef.current;
    if (!wb) return;
    setExporting(true);
    try {
      const buf = await wb.xlsx.writeBuffer();
      saveAs(
        new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        filename,
      );
    } catch (e) {
      console.error(e);
      alert('Lỗi khi xuất Excel. Vui lòng thử lại.');
    } finally {
      setExporting(false);
    }
  }

  // ── Derived UI values ──────────────────────────────────────────────────────

  const revCount      = safeResults.filter(needsReview).length;
  const srcLabel      = dataSource === 'db' ? 'Database' : 'Trình duyệt (localStorage)';
  const activeTabDef  = TABS.find(t => t.id === activeTab)!;
  const activeSheet   = display?.sheets[activeTabDef.sheetIdx] ?? null;
  const templateLabel = batch ? TEMPLATE_VARIANT_LABEL[batch.templateVariant] : '';

  // ── Shared spin CSS ────────────────────────────────────────────────────────

  const SpinCss = () => (
    <style>{`@keyframes vju-spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
  );
  const spinStyle: React.CSSProperties = { animation: 'vju-spin 1s linear infinite' };

  // ── Loading ────────────────────────────────────────────────────────────────

  if (loadState === 'loading') return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: WASHI_BG }}>
      <SpinCss />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: INK_MUTED, fontSize: 13 }}>
        <RefreshCw size={18} style={spinStyle} />
        Đang tải kết quả…
      </div>
    </div>
  );

  // ── Empty ──────────────────────────────────────────────────────────────────

  if (loadState === 'empty' || !batch) return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: WASHI_BG }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: 380 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: INK, marginBottom: 8 }}>
            Chưa có kết quả để xem trước
          </div>
          <div style={{ fontSize: 14, color: INK_MUTED, marginBottom: 24 }}>
            Hãy vào Upload &amp; Chấm để chấm phiếu trước.
          </div>
          <button
            onClick={() => navigate('/app/upload')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 20px', background: SAGE, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}
          >
            <ArrowLeft size={14} /> Quay lại Upload
          </button>
        </div>
      </div>
    </div>
  );

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: WASHI_BG }}>
      <SpinCss />

      {/* ── White header card ─────────────────────────────────────────────── */}
      <div style={{
        background:   WASHI_CARD,
        borderBottom: `1px solid ${WASHI_BORDER}`,
        padding:      '16px 28px',
        display:      'flex',
        alignItems:   'center',
        justifyContent: 'space-between',
        gap:          16,
        flexShrink:   0,
      }}>
        {/* Left: titles */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Back arrow */}
          <button
            onClick={() => navigate('/app/results')}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, background: '#f1f5f9', border: `1px solid ${WASHI_BORDER}`, borderRadius: 8, cursor: 'pointer', color: INK_MUTED }}
          >
            <ArrowLeft size={15} />
          </button>

          <div>
            {/* Eyebrow */}
            <div style={{ fontSize: 10, fontWeight: 700, color: INK_MUTED, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2 }}>
              VJU · EXCEL EXPORT PREVIEW
            </div>
            {/* Title */}
            <div style={{ fontSize: 20, fontWeight: 800, color: INK, lineHeight: 1.2 }}>
              Bảng xuất kết quả Excel
            </div>
            {/* Subtitle */}
            <div style={{ fontSize: 12, color: INK_MUTED, marginTop: 2 }}>
              Bảng điểm thi trắc nghiệm
              {examName && <> · Kỳ thi <strong style={{ color: INK }}>{examName}</strong></>}
              {' · '}Mẫu phiếu <strong style={{ color: INK }}>{templateLabel}</strong>
              {' · '}{safeResults.length} phiếu · {srcLabel}
            </div>
          </div>
        </div>

        {/* Right: action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <ActionBtn onClick={() => window.print()} icon={<Printer size={14} />}>In</ActionBtn>
          <ActionBtn
            onClick={handleDownload}
            icon={<Download size={14} />}
            primary
            disabled={exporting || !workbookRef.current}
          >
            {exporting ? 'Đang xuất…' : 'Tải .xlsx'}
          </ActionBtn>
        </div>
      </div>

      {/* ── SAGE green Excel toolbar ──────────────────────────────────────── */}
      <div style={{
        background:   SAGE,
        padding:      '0 20px',
        display:      'flex',
        alignItems:   'center',
        gap:          0,
        borderBottom: `2px solid ${SAGE_DARK}`,
        flexShrink:   0,
        minHeight:    36,
      }}>
        {/* Icon + filename */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingRight: 16, borderRight: '1px solid rgba(255,255,255,0.2)' }}>
          <FileSpreadsheet size={15} color="rgba(255,255,255,0.9)" />
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>{filename}</span>
        </div>

        {/* Active sheet */}
        <div style={{ padding: '0 16px', borderRight: '1px solid rgba(255,255,255,0.2)', fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
          Sheet: <span style={{ color: '#fff', fontWeight: 600 }}>{activeTabDef.label}</span>
        </div>

        {/* Edit mode toggle */}
        <div style={{ padding: '0 14px', borderRight: '1px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', gap: 7 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={editMode}
              onChange={e => setEditMode(e.target.checked)}
              style={{ accentColor: '#dcfce7', width: 13, height: 13, cursor: 'pointer' }}
            />
            <Edit3 size={12} color={editMode ? '#dcfce7' : 'rgba(255,255,255,0.6)'} />
            <span style={{ fontSize: 11, color: editMode ? '#dcfce7' : 'rgba(255,255,255,0.7)', fontWeight: editMode ? 700 : 400 }}>
              Chế độ chỉnh sửa
            </span>
          </label>
        </div>

        {/* Formula legend */}
        <div style={{ padding: '0 14px', fontSize: 11, color: 'rgba(255,255,255,0.6)', display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ display: 'inline-block', width: 11, height: 11, background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.4)', borderRadius: 2 }} />
          <span>= công thức tự động</span>
        </div>

        {/* Spacer + review legend */}
        {revCount > 0 && (
          <div style={{ marginLeft: 'auto', padding: '0 14px', fontSize: 11, color: 'rgba(255,255,255,0.7)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 11, height: 11, background: '#FEF3C7', border: '1px solid #F59E0B', display: 'inline-block', borderRadius: 2 }} />
            <span>Cần kiểm tra ({revCount})</span>
          </div>
        )}
      </div>

      {/* ── Light tab bar ─────────────────────────────────────────────────── */}
      <div style={{
        background:   WASHI_CARD,
        padding:      '0 20px',
        display:      'flex',
        alignItems:   'flex-end',
        gap:          2,
        borderBottom: `2px solid ${WASHI_BORDER}`,
        flexShrink:   0,
      }}>
        {TABS.map(tab => {
          const isActive = activeTab === tab.id;
          const badge    = tab.id === 'can_kiem_tra' ? revCount : 0;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding:      '8px 16px',
                background:   'transparent',
                color:        isActive ? SEAL_RED : INK_MUTED,
                border:       'none',
                borderBottom: isActive ? `2px solid ${SEAL_RED}` : '2px solid transparent',
                borderRadius: '4px 4px 0 0',
                cursor:       'pointer',
                fontSize:     12,
                fontWeight:   isActive ? 700 : 500,
                fontFamily:   'inherit',
                display:      'flex',
                alignItems:   'center',
                gap:          6,
                transition:   'color 150ms, border-color 150ms',
                marginBottom: -2,
                whiteSpace:   'nowrap',
              }}
            >
              {tab.label}
              {badge > 0 && (
                <span style={{
                  background:   isActive ? '#fef3c7' : '#f3f4f6',
                  color:        isActive ? '#92400e' : INK_MUTED,
                  borderRadius: 9999,
                  fontSize:     10,
                  fontWeight:   700,
                  padding:      '1px 6px',
                  lineHeight:   1.6,
                }}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, background: WASHI_BG, padding: '20px 28px', overflowY: 'auto' }}>

        {/* Edit mode hint banner */}
        {editMode && (
          <div style={{ marginBottom: 12, padding: '8px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 12, color: '#15803d', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Edit3 size={13} />
            <span>Chế độ chỉnh sửa đang bật — Double-click ô để sửa · Enter lưu · Esc hủy · Ô công thức chỉ xem</span>
          </div>
        )}

        {/* Review warning (Bảng điểm tab) */}
        {activeTab === 'bang_diem' && revCount > 0 && (
          <div style={{ marginBottom: 12, padding: '9px 14px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
            <span>
              <AlertTriangle size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
              <strong>{revCount} phiếu cần kiểm tra</strong> — tô màu vàng trong bảng bên dưới.
            </span>
            <button
              onClick={() => setActiveTab('can_kiem_tra')}
              style={{ border: '1px solid #fcd34d', background: '#fff', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 11, color: '#92400e', fontFamily: 'inherit', fontWeight: 600 }}
            >
              Xem tab →
            </button>
          </div>
        )}

        {/* DB source badge */}
        {dataSource === 'db' && (
          <div style={{ marginBottom: 12, padding: '6px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 11, color: '#1d4ed8', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            🔗 Dữ liệu từ database — {safeResults.length} phiếu
          </div>
        )}

        {/* ── WorkbookPreview card ─────────────────────────────────────── */}
        <div style={{
          background:   WASHI_CARD,
          borderRadius: 10,
          border:       `1px solid ${WASHI_BORDER}`,
          overflow:     'hidden',
          boxShadow:    '0 1px 6px rgba(0,0,0,0.06)',
        }}>
          {activeSheet ? (
            <WorkbookPreview
              sheet={activeSheet}
              maxHeight="66vh"
              editable={editMode}
              onCellChange={handleCellChange}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: INK_MUTED, fontSize: 13, gap: 8 }}>
              <RefreshCw size={16} style={spinStyle} />
              Đang xây dựng workbook…
            </div>
          )}
        </div>

        {/* ── Bottom action bar ─────────────────────────────────────────── */}
        <div style={{
          marginTop:   20,
          padding:     '14px 20px',
          background:  WASHI_CARD,
          borderRadius:10,
          border:      `1px solid ${WASHI_BORDER}`,
          display:     'flex',
          alignItems:  'center',
          justifyContent: 'space-between',
          boxShadow:   '0 1px 4px rgba(0,0,0,0.04)',
        }}>
          <div style={{ fontSize: 11, color: INK_MUTED, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileSpreadsheet size={13} style={{ color: SAGE }} />
            <span style={{ fontFamily: 'monospace', color: INK }}>{filename}</span>
            <span>· {safeResults.length} phiếu · {srcLabel}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <ActionBtn onClick={() => navigate('/app/results')} icon={<ArrowLeft size={13} />}>
              Quay lại Kết quả
            </ActionBtn>
            <ActionBtn
              onClick={handleDownload}
              icon={<Download size={13} />}
              primary
              disabled={exporting || !workbookRef.current}
            >
              {exporting ? 'Đang xuất…' : 'Tải .xlsx'}
            </ActionBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ActionBtn ─────────────────────────────────────────────────────────────────

function ActionBtn({
  children, onClick, icon, primary = false, disabled = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  icon?: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display:      'inline-flex',
        alignItems:   'center',
        gap:          6,
        padding:      '7px 14px',
        background:   primary ? SAGE : WASHI_CARD,
        color:        primary ? '#fff' : INK,
        border:       `1px solid ${primary ? SAGE_DARK : WASHI_BORDER}`,
        borderRadius: 8,
        cursor:       disabled ? 'not-allowed' : 'pointer',
        fontSize:     12,
        fontWeight:   600,
        fontFamily:   'inherit',
        transition:   'background 150ms, opacity 150ms',
        opacity:      disabled ? 0.55 : 1,
      }}
    >
      {icon}
      {children}
    </button>
  );
}
