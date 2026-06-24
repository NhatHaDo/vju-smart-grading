/**
 * ExcelPreviewPage.tsx
 * Route: /app/excel-preview
 *
 * A dedicated screen that looks like an Excel report preview before download.
 * Data: DB-first (GET /api/v1/results), fallback localStorage.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Printer, ArrowLeft, FileSpreadsheet, AlertTriangle, RefreshCw } from 'lucide-react';
import PageHeader from '../components/layout/PageHeader';
import Button from '../components/common/Button';
import ExcelLikePreview from '../components/excel/ExcelLikePreview';
import { exportResultsExcel } from '../utils/exportResultsExcel';
import { dbRowToOmrResult } from '../utils/resultMapping';
import { resultsApi } from '../services/apiClient';
import { loadAnswerKey, loadCorrections, computeScore, applyCorrection, TEMPLATE_VARIANT_LABEL } from '../types/grading';
import type { BatchGradeState, OmrGradeResult, AnswerKeyStore, CorrectionsStore } from '../types/grading';

// ── constants ─────────────────────────────────────────────────────────────────

const LS_KEY = 'vju_last_batch_grade';

// ── helpers ───────────────────────────────────────────────────────────────────

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

function fmtDateShort(iso: string) {
  try {
    const now = new Date();
    const p   = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
  } catch { return iso.slice(0, 10); }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type LoadState = 'loading' | 'ok' | 'empty' | 'error';
type DataSource = 'db' | 'localStorage';
type Tab = 'bang_diem' | 'can_kiem_tra' | 'tong_quan' | 'chi_tiet';

const TABS: { id: Tab; label: string }[] = [
  { id: 'tong_quan',    label: 'Tổng quan' },
  { id: 'bang_diem',    label: 'Bảng điểm' },
  { id: 'can_kiem_tra', label: 'Cần kiểm tra' },
  { id: 'chi_tiet',     label: 'Chi tiết đáp án' },
];

// ── Palette ───────────────────────────────────────────────────────────────────

const C = {
  toolbarBg:   '#2B2B2B',
  toolbarTxt:  '#D4C9B8',
  toolbarMuted:'#7B7060',
  tabActiveBg: '#FAF7F2',
  tabActiveTxt:'#C8102E',
  tabBg:       '#3A3530',
  tabTxt:      '#B8A898',
  pageBg:      '#F0EBE2',
  red:         '#C8102E',
  cream:       '#FAF7F2',
  border:      '#E6DCCF',
  dark:        '#1F2937',
  muted:       '#6B7280',
  warn:        '#F59E0B',
  warnBg:      '#FEF3C7',
  warnTxt:     '#92400E',
  ok:          '#15803D',
  okBg:        '#D1FAE5',
} as const;

// ── Tổng quan tab ─────────────────────────────────────────────────────────────

function TongQuanTab({
  batch, results, answerKey, corrections,
}: {
  batch: BatchGradeState;
  results: OmrGradeResult[];
  answerKey: AnswerKeyStore | null;
  corrections: CorrectionsStore;
}) {
  const hasKey = !!answerKey && Object.keys(answerKey.answers ?? {}).length > 0;
  const scored = results.map(r => {
    const c = corrections[r.input?.filename ?? ''];
    const m = applyCorrection(r, c);
    return hasKey ? computeScore(m.answers ?? {}, answerKey!) : null;
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  const total    = results.length;
  const revCnt   = results.filter(needsReview).length;
  const corrCnt  = Object.keys(corrections).length;
  const avg      = scored.length ? Math.round(scored.reduce((a, b) => a + b.total, 0) / scored.length * 100) / 100 : null;
  const hi       = scored.length ? Math.max(...scored.map(s => s.total)) : null;
  const lo       = scored.length ? Math.min(...scored.map(s => s.total)) : null;

  const kpis: { label: string; value: string | number; accent: string; sub: string }[] = [
    { label: 'Tổng phiếu',        value: total,          accent: C.red,  sub: 'Đã xử lý' },
    { label: 'Cần kiểm tra',      value: revCnt,         accent: C.warn, sub: 'Phiếu có cảnh báo' },
    { label: 'Đã sửa tay',        value: corrCnt,        accent: C.ok,   sub: 'Corrections' },
    { label: 'Phiếu có điểm',     value: scored.length,  accent: '#6366F1', sub: `/ ${total} phiếu` },
    { label: 'Điểm trung bình',   value: avg   ?? '—',   accent: C.ok,   sub: 'Score TB' },
    { label: 'Điểm cao nhất',     value: hi    ?? '—',   accent: '#2563EB', sub: 'Max' },
    { label: 'Điểm thấp nhất',    value: lo    ?? '—',   accent: '#EF4444', sub: 'Min' },
    { label: 'Template',          value: batch.templateVariant.toUpperCase(), accent: C.dark, sub: TEMPLATE_VARIANT_LABEL[batch.templateVariant] },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, padding: '24px 0' }}>
      {kpis.map((k, i) => (
        <div key={i} style={{
          background: '#fff',
          borderRadius: 12,
          padding: '20px 18px',
          border: `1px solid ${C.border}`,
          borderTop: `3px solid ${k.accent}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
        }}>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{k.label}</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: C.dark, lineHeight: 1 }}>{k.value}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{k.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ── Cần kiểm tra tab ──────────────────────────────────────────────────────────

function CanKiemTraTab({
  results, answerKey, corrections,
}: {
  results: OmrGradeResult[];
  answerKey: AnswerKeyStore | null;
  corrections: CorrectionsStore;
}) {
  const hasKey = !!answerKey && Object.keys(answerKey.answers ?? {}).length > 0;
  const review = results.filter(needsReview);

  if (review.length === 0) return (
    <div style={{ padding: '60px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.ok }}>Không có phiếu nào cần kiểm tra</div>
      <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>Tất cả phiếu đã chấm thành công.</div>
    </div>
  );

  return (
    <div style={{ marginTop: 16, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: C.red }}>
            {['STT', 'File', 'SBD', 'CCCD', 'Mã đề', ...(hasKey ? ['Điểm'] : []), 'Lý do cần kiểm tra'].map(h => (
              <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#fff', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {review.map((r, i) => {
            const c   = corrections[r.input?.filename ?? ''];
            const m   = applyCorrection(r, c);
            const sc  = hasKey ? computeScore(m.answers ?? {}, answerKey!) : null;
            const inf = m.student_info ?? r.student_info ?? {};
            const warns = r.warnings ?? [];
            const reasons: string[] = [];
            if (r._error)                                    reasons.push('Lỗi chấm phiếu');
            if (warns.some(w => w.type === 'multi_mark'))    reasons.push('Nhiều ô tô (MCQ)');
            if (warns.some(w => w.type === 'multi_mark_info_field')) reasons.push('Thông tin không chắc');
            const bl = r.score?.blank ?? 0;
            if (bl > 0)                                      reasons.push(`${bl} câu trống`);
            return (
              <tr key={i} style={{ background: i % 2 ? C.warnBg : '#fff', borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: '9px 12px', color: C.muted }}>{i + 1}</td>
                <td style={{ padding: '9px 12px', color: C.dark, fontWeight: 500, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.input?.filename ?? '—'}</td>
                <td style={{ padding: '9px 12px', fontFamily: 'monospace' }}>{inf.sbd ?? '—'}</td>
                <td style={{ padding: '9px 12px', fontFamily: 'monospace', color: C.red, fontWeight: 600 }}>{inf.cccd ?? '—'}</td>
                <td style={{ padding: '9px 12px', fontFamily: 'monospace' }}>{inf.ma_de ?? '—'}</td>
                {hasKey && <td style={{ padding: '9px 12px', fontWeight: 800, textAlign: 'center' }}>{sc?.total ?? '—'}</td>}
                <td style={{ padding: '9px 12px', color: C.warnTxt, fontWeight: 600 }}>{reasons.join(', ') || 'Cần kiểm tra'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Chi tiết đáp án tab ───────────────────────────────────────────────────────

function collectKeys(results: OmrGradeResult[]): string[] {
  const seen = new Set<string>();
  for (const r of results) for (const k of Object.keys(r.answers ?? {})) seen.add(k);
  const order = [
    ...Array.from({ length: 15 }, (_, i) => `toan${i + 1}`),
    ...Array.from({ length: 5  }, (_, i) => `ptbv${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `vl${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `hh${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `sh${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `cnnn${i + 1}`),
  ];
  const sorted: string[] = [];
  for (const k of order) { if (seen.has(k)) { sorted.push(k); seen.delete(k); } }
  for (const k of [...seen].sort()) sorted.push(k);
  return sorted;
}

function ChiTietTab({ results, corrections }: {
  results: OmrGradeResult[];
  corrections: CorrectionsStore;
}) {
  const keys = collectKeys(results);
  if (keys.length === 0) return (
    <div style={{ padding: '40px', textAlign: 'center', color: C.muted }}>Không có dữ liệu đáp án.</div>
  );

  return (
    <div style={{ marginTop: 16, overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11, tableLayout: 'auto' }}>
        <thead>
          <tr style={{ background: C.red }}>
            {['STT', 'File', 'SBD', 'Mã đề', ...keys.map((_, i) => `Câu ${i + 1}`)].map(h => (
              <th key={h} style={{ padding: '9px 8px', textAlign: 'center', color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', minWidth: 42 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const c   = corrections[r.input?.filename ?? ''];
            const m   = applyCorrection(r, c);
            const inf = m.student_info ?? r.student_info ?? {};
            const ans = m.answers ?? {};
            return (
              <tr key={i} style={{ background: i % 2 ? '#F9FAFB' : '#fff', borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: '7px 8px', color: C.muted, textAlign: 'center' }}>{i + 1}</td>
                <td style={{ padding: '7px 8px', minWidth: 140, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}>{r.input?.filename ?? '—'}</td>
                <td style={{ padding: '7px 8px', fontFamily: 'monospace', textAlign: 'center' }}>{inf.sbd ?? '—'}</td>
                <td style={{ padding: '7px 8px', fontFamily: 'monospace', textAlign: 'center' }}>{inf.ma_de ?? '—'}</td>
                {keys.map(k => (
                  <td key={k} style={{ padding: '7px 8px', textAlign: 'center', fontWeight: 600 }}>
                    {ans[k] ?? '—'}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ExcelPreviewPage() {
  const navigate = useNavigate();

  const [loadState,   setLoadState]   = useState<LoadState>('loading');
  const [dataSource,  setDataSource]  = useState<DataSource>('db');
  const [batch,       setBatch]       = useState<BatchGradeState | null>(null);
  const [answerKey,   setAnswerKey]   = useState<AnswerKeyStore | null>(null);
  const [corrections, setCorrections] = useState<CorrectionsStore>({});
  const [activeTab,   setActiveTab]   = useState<Tab>('bang_diem');
  const [exporting,   setExporting]   = useState(false);

  const loadData = useCallback(async () => {
    setLoadState('loading');
    setAnswerKey(loadAnswerKey());
    setCorrections(loadCorrections());

    // Resolve exam context from localStorage batch
    const lsBatch = loadFromStorage();
    const examId   = lsBatch?.examId   ?? null;
    const examName = lsBatch?.examName ?? null;

    try {
      const params: Parameters<typeof resultsApi.list>[0] = { limit: 500 };
      if (examId !== null) params.exam_id = examId;
      const resp = await resultsApi.list(params);
      if (resp.items.length > 0) {
        const converted = resp.items.map(dbRowToOmrResult);
        const first = resp.items[0];
        setBatch({
          templateVariant: (first.template_variant as BatchGradeState['templateVariant']) ?? 'sbd8',
          results:  converted,
          gradedAt: first.graded_at,
          examId:   first.exam_id ?? examId,
          examName: examName,
        });
        setDataSource('db');
        setLoadState('ok');
        return;
      }
    } catch {
      // DB failed → try localStorage
    }

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

  const safeResults = batch?.results ?? [];
  const revCount    = safeResults.filter(needsReview).length;
  const srcLabel    = dataSource === 'db' ? 'Database' : 'Trình duyệt (localStorage)';
  const examName    = batch?.examName ?? null;

  // Filename preview — include exam name when available
  const now = new Date();
  const p   = (n: number) => String(n).padStart(2, '0');
  const ts  = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
  const examSlug = examName
    ? '_' + examName.replace(/[^a-zA-Z0-9À-ỹ]/g, '_').replace(/_+/g, '_').slice(0, 30)
    : '';
  const filename = `vju_smart_grading${examSlug}_${ts}.xlsx`;

  async function handleDownload() {
    if (!batch) return;
    setExporting(true);
    try {
      await exportResultsExcel({ batch, results: safeResults, answerKey, corrections, dataSource: srcLabel, examName });
    } catch (e) {
      console.error(e);
      alert('Lỗi khi xuất Excel. Vui lòng thử lại.');
    } finally {
      setExporting(false);
    }
  }

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loadState === 'loading') return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader title="Xem trước Excel" subtitle="Đang tải dữ liệu…" />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: C.muted }}>
        <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} />
        Đang tải kết quả từ database…
        <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
      </div>
    </div>
  );

  // ── Empty state ───────────────────────────────────────────────────────────

  if (loadState === 'empty' || !batch) return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title="Xem trước Excel"
        subtitle="Preview bảng điểm trước khi tải"
        actions={<Button variant="secondary" size="sm" icon={<ArrowLeft size={14} />} onClick={() => navigate('/app/upload')}>Quay lại Upload</Button>}
      />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: 380 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.dark, marginBottom: 8 }}>
            Chưa có kết quả để xem trước Excel
          </div>
          <div style={{ fontSize: 14, color: C.muted, marginBottom: 24 }}>
            Hãy vào Upload &amp; Chấm để chấm phiếu trước.
          </div>
          <Button variant="primary" icon={<ArrowLeft size={14} />} onClick={() => navigate('/app/upload')}>
            Quay lại Upload
          </Button>
        </div>
      </div>
    </div>
  );

  // ── Main render ───────────────────────────────────────────────────────────

  const activeTabLabel = TABS.find(t => t.id === activeTab)?.label ?? '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>

      {/* ── Page header ───────────────────────────────────────────────────── */}
      <PageHeader
        title={examName ? `Xem trước Excel: ${examName}` : 'Xem trước Excel'}
        subtitle={`${safeResults.length} phiếu · ${TEMPLATE_VARIANT_LABEL[batch.templateVariant]} · nguồn: ${srcLabel}`}
        actions={<>
          <Button variant="secondary" size="sm" icon={<ArrowLeft size={14} />} onClick={() => navigate('/app/results')}>
            Kết quả
          </Button>
          <Button
            variant="secondary" size="sm" icon={<Download size={14} />}
            onClick={handleDownload}
            disabled={exporting}
          >
            {exporting ? 'Đang xuất…' : 'Tải .xlsx'}
          </Button>
        </>}
      />

      {/* ── Excel application bar ─────────────────────────────────────────── */}
      <div style={{
        background: C.toolbarBg,
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        borderBottom: '2px solid #1A1A1A',
        flexShrink: 0,
      }}>
        {/* App icon + name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 10px 0', borderRight: '1px solid #444' }}>
          <FileSpreadsheet size={18} color="#C8102E" />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#E8DDD0', letterSpacing: '0.01em' }}>VJU Smart Grading</span>
        </div>

        {/* Filename */}
        <div style={{ padding: '10px 20px', borderRight: '1px solid #444', fontSize: 12, color: C.toolbarMuted }}>
          <span style={{ color: C.toolbarTxt, fontFamily: 'monospace', fontSize: 11 }}>{filename}</span>
        </div>

        {/* Active sheet */}
        <div style={{ padding: '10px 16px', borderRight: '1px solid #444', fontSize: 12, color: C.toolbarMuted }}>
          Sheet: <span style={{ color: C.toolbarTxt, fontWeight: 600 }}>{activeTabLabel}</span>
        </div>

        {/* Legend */}
        {revCount > 0 && (
          <div style={{ padding: '10px 16px', fontSize: 11, color: C.toolbarMuted, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 12, height: 12, background: '#FEF3C7', border: '1px solid #F59E0B', display: 'inline-block', borderRadius: 2 }} />
            <span>Cần kiểm tra ({revCount})</span>
            <span style={{ marginLeft: 10, width: 12, height: 12, background: '#D1FAE5', border: '1px solid #10B981', display: 'inline-block', borderRadius: 2 }} />
            <span>Đã chấm</span>
          </div>
        )}

        {/* Spacer + Print/Download buttons */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2, padding: '6px 0' }}>
          <ToolBtn icon={<Printer size={14} />} label="In" onClick={() => window.print()} />
          <ToolBtn
            icon={<Download size={14} />} label={exporting ? 'Đang xuất…' : 'Tải .xlsx'}
            onClick={handleDownload} primary disabled={exporting}
          />
        </div>
      </div>

      {/* ── Sheet tabs bar ────────────────────────────────────────────────── */}
      <div style={{
        background: '#353030',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'flex-end',
        gap: 2,
        borderBottom: `3px solid ${C.red}`,
        flexShrink: 0,
      }}>
        {TABS.map(tab => {
          const isActive = activeTab === tab.id;
          const count = tab.id === 'can_kiem_tra' ? revCount : null;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '8px 18px',
                background: isActive ? C.tabActiveBg : C.tabBg,
                color: isActive ? C.tabActiveTxt : C.tabTxt,
                border: 'none',
                borderTop: isActive ? `2px solid ${C.red}` : '2px solid transparent',
                borderRadius: '6px 6px 0 0',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: isActive ? 700 : 500,
                fontFamily: 'inherit',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                transition: 'background 150ms, color 150ms',
                marginBottom: -3,
              }}
            >
              {tab.label}
              {count != null && count > 0 && (
                <span style={{
                  background: isActive ? '#FEF3C7' : '#5A4A3A',
                  color:      isActive ? '#92400E' : '#C8A882',
                  borderRadius: 9999,
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '1px 6px',
                  lineHeight: 1.6,
                }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Main content area ─────────────────────────────────────────────── */}
      <div style={{
        flex: 1,
        background: C.pageBg,
        padding: '24px 28px',
        overflowY: 'auto',
      }}>

        {/* Source indicator */}
        {dataSource === 'db' && (
          <div style={{ marginBottom: 16, padding: '8px 14px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, fontSize: 12, color: '#1D4ED8', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            🔗 Dữ liệu từ database — {safeResults.length} phiếu
          </div>
        )}

        {/* Warning if review count > 0 */}
        {activeTab === 'bang_diem' && revCount > 0 && (
          <div style={{ marginBottom: 16, padding: '9px 14px', background: C.warnBg, border: `1px solid #FDE68A`, borderRadius: 8, fontSize: 12, color: C.warnTxt, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
            <span>
              <AlertTriangle size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
              <strong>{revCount} phiếu cần kiểm tra</strong> — tô màu vàng trong bảng bên dưới. Xem tab "Cần kiểm tra" để biết chi tiết.
            </span>
            <button onClick={() => setActiveTab('can_kiem_tra')}
              style={{ border: '1px solid #FCD34D', background: '#FFF', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 11, color: C.warnTxt, fontFamily: 'inherit', fontWeight: 600 }}>
              Xem tab →
            </button>
          </div>
        )}

        {/* ── Tab content ─────────────────────────────────────────────────── */}
        {activeTab === 'bang_diem' && (
          <ExcelLikePreview
            batch={batch}
            results={safeResults}
            answerKey={answerKey}
            corrections={corrections}
            dataSource={srcLabel}
          />
        )}

        {activeTab === 'tong_quan' && (
          <TongQuanTab
            batch={batch}
            results={safeResults}
            answerKey={answerKey}
            corrections={corrections}
          />
        )}

        {activeTab === 'can_kiem_tra' && (
          <CanKiemTraTab
            results={safeResults}
            answerKey={answerKey}
            corrections={corrections}
          />
        )}

        {activeTab === 'chi_tiet' && (
          <ChiTietTab
            results={safeResults}
            corrections={corrections}
          />
        )}

        {/* ── Bottom action bar ────────────────────────────────────────────── */}
        <div style={{
          marginTop: 28, padding: '16px 20px', background: '#fff',
          borderRadius: 12, border: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
        }}>
          <div style={{ fontSize: 12, color: C.muted }}>
            <FileSpreadsheet size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            <span style={{ fontFamily: 'monospace', color: C.dark }}>{filename}</span>
            <span style={{ marginLeft: 12, color: C.muted }}>· {safeResults.length} phiếu · {srcLabel}</span>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button variant="secondary" size="sm" onClick={() => navigate('/app/results')}>
              Quay lại Kết quả
            </Button>
            <Button
              variant="primary" size="sm" icon={<Download size={13} />}
              onClick={handleDownload} disabled={exporting}
              style={{ background: C.red, borderColor: C.red }}
            >
              {exporting ? 'Đang xuất…' : 'Tải .xlsx'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ToolBtn ───────────────────────────────────────────────────────────────────

function ToolBtn({ icon, label, onClick, primary = false, disabled = false }: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '5px 12px',
        background: primary ? C.red : 'transparent',
        color:      primary ? '#fff'  : '#C8B89A',
        border:     primary ? `1px solid #9B0C22` : '1px solid transparent',
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 11,
        fontFamily: 'inherit',
        fontWeight: 600,
        transition: 'background 150ms',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
