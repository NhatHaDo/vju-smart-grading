/**
 * ExcelPreviewModal — shown before downloading Excel report.
 * Lets the teacher configure sheet options and see a 3-row preview.
 */
import { useState } from 'react';
import { Download, X, FileSpreadsheet, CheckSquare, Square } from 'lucide-react';
import Button from '../common/Button';
import type { BatchGradeState, OmrGradeResult, AnswerKeyStore, CorrectionsStore } from '../../types/grading';
import { TEMPLATE_VARIANT_LABEL, computeScore, applyCorrection } from '../../types/grading';
import { exportResultsExcel } from '../../utils/exportResultsExcel';

// ── helpers ────────────────────────────────────────────────────────────────

function needsReview(r: OmrGradeResult): boolean {
  return (r.warnings ?? []).length > 0 || (r.score?.blank ?? 0) > 0 || !!r._error;
}

function dash(v: string | null | undefined): string {
  return v == null || v === '' ? '—' : v;
}

// ── sub-components ─────────────────────────────────────────────────────────

function Checkbox({ checked, onChange, label }: {
  checked: boolean; onChange: (v: boolean) => void; label: string;
}) {
  return (
    <label
      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
               fontSize: 13, color: '#374151', userSelect: 'none' }}
      onClick={() => onChange(!checked)}
    >
      {checked
        ? <CheckSquare size={16} color="#C8102E" style={{ flexShrink: 0 }} />
        : <Square      size={16} color="#D1D5DB" style={{ flexShrink: 0 }} />}
      {label}
    </label>
  );
}

interface SheetRowProps { name: string; included: boolean; description: string; }
function SheetRow({ name, included, description }: SheetRowProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '8px 12px', borderRadius: 8,
      background: included ? '#F0FDF4' : '#F9FAFB',
      border: `1px solid ${included ? '#BBF7D0' : '#E5E7EB'}`,
    }}>
      <FileSpreadsheet size={15} color={included ? '#10B981' : '#9CA3AF'} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: included ? '#065F46' : '#6B7280' }}>{name}</span>
        <span style={{ fontSize: 11, color: '#9CA3AF', marginLeft: 8 }}>{description}</span>
      </div>
      <span style={{
        fontSize: 10, fontWeight: 700, borderRadius: 9999, padding: '2px 8px',
        background: included ? '#D1FAE5' : '#F3F4F6',
        color:      included ? '#065F46' : '#9CA3AF',
      }}>
        {included ? 'BẬT' : 'TẮT'}
      </span>
    </div>
  );
}

// ── Preview table ──────────────────────────────────────────────────────────

function PreviewTable({ results, answerKey, corrections }: {
  results:     OmrGradeResult[];
  answerKey:   AnswerKeyStore | null;
  corrections: CorrectionsStore;
}) {
  const previewRows = results.slice(0, 3);
  const hasKey = !!answerKey && Object.keys(answerKey.answers ?? {}).length > 0;

  if (previewRows.length === 0) return null;

  return (
    <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #E5E7EB' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ background: '#C8102E' }}>
            {['STT', 'File', 'SBD', 'CCCD', 'Mã đề', 'Ca thi',
              ...(hasKey ? ['Đúng', 'Sai', 'Trống', 'Điểm'] : []),
              'Trạng thái',
            ].map(h => (
              <th key={h} style={{ padding: '7px 10px', textAlign: 'left', color: '#fff', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {previewRows.map((r, i) => {
            const fname   = r.input?.filename ?? '';
            const corr    = corrections[fname];
            const merged  = applyCorrection(r, corr);
            const sc      = hasKey ? computeScore(merged.answers ?? {}, answerKey!) : null;
            const info    = merged.student_info ?? r.student_info ?? {};
            const review  = needsReview(r);
            return (
              <tr key={i} style={{ background: i % 2 ? '#F9FAFB' : '#fff', borderBottom: '1px solid #F3F4F6' }}>
                <td style={{ padding: '7px 10px', color: '#9CA3AF' }}>{i + 1}</td>
                <td style={{ padding: '7px 10px', color: '#374151', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dash(fname)}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{dash(info.sbd)}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', color: '#C8102E', fontWeight: 600 }}>{dash(info.cccd)}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{dash(info.ma_de)}</td>
                <td style={{ padding: '7px 10px' }}>{dash(info.ca_thi)}</td>
                {sc !== null && <>
                  <td style={{ padding: '7px 10px', color: '#065F46', fontWeight: 600 }}>{sc.correct}</td>
                  <td style={{ padding: '7px 10px', color: '#991B1B', fontWeight: 600 }}>{sc.wrong}</td>
                  <td style={{ padding: '7px 10px', color: '#6B7280' }}>{sc.blank}</td>
                  <td style={{ padding: '7px 10px', fontWeight: 800, color: '#1E1E1E' }}>{sc.total}</td>
                </>}
                <td style={{ padding: '7px 10px' }}>
                  <span style={{
                    fontSize: 10, borderRadius: 9999, padding: '2px 7px', fontWeight: 600,
                    background: review ? '#FEF3C7' : '#D1FAE5',
                    color:      review ? '#92400E' : '#065F46',
                  }}>
                    {review ? 'Cần kiểm tra' : 'Đã chấm'}
                  </span>
                </td>
              </tr>
            );
          })}
          {results.length > 3 && (
            <tr>
              <td colSpan={20} style={{ padding: '6px 10px', color: '#9CA3AF', fontSize: 10, textAlign: 'center', background: '#F9FAFB' }}>
                ... và {results.length - 3} phiếu nữa trong file
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export interface ExcelPreviewModalProps {
  batch:       BatchGradeState;
  results:     OmrGradeResult[];
  answerKey:   AnswerKeyStore | null;
  corrections: CorrectionsStore;
  dataSource:  string;
  onClose:     () => void;
  onSuccess:   () => void;
}

export default function ExcelPreviewModal({
  batch, results, answerKey, corrections, dataSource, onClose, onSuccess,
}: ExcelPreviewModalProps) {
  const [includeReview,   setIncludeReview]   = useState(true);
  const [includeAnswers,  setIncludeAnswers]   = useState(true);
  const [highlightReview, setHighlightReview]  = useState(true);
  const [exporting,       setExporting]        = useState(false);

  const reviewCount = results.filter(needsReview).length;
  const templateLabel = batch.templateMode === 'custom'
    ? (batch.customTemplateName ? `Custom: ${batch.customTemplateName}` : 'Custom template')
    : (TEMPLATE_VARIANT_LABEL[batch.templateVariant] ?? batch.templateVariant);

  async function handleDownload() {
    setExporting(true);
    try {
      await exportResultsExcel({
        batch, results, answerKey, corrections, dataSource,
        examName: batch.examName ?? null,
        includeReview, includeAnswers, highlightReview,
      });
      onSuccess();
      onClose();
    } catch (e) {
      console.error(e);
      alert('Có lỗi khi xuất Excel. Vui lòng thử lại.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.45)',
          zIndex: 9998,
        }}
      />

      {/* Modal */}
      <div style={{
        position: 'fixed',
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        background: '#fff',
        borderRadius: 16,
        boxShadow: '0 24px 60px rgba(0,0,0,0.22)',
        zIndex: 9999,
        width: '90vw',
        maxWidth: 760,
        maxHeight: '90vh',
        overflowY: 'auto',
        padding: 28,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#1E1E1E', display: 'flex', alignItems: 'center', gap: 8 }}>
              <FileSpreadsheet size={20} color="#C8102E" />
              Xem trước file Excel
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 3 }}>
              {results.length} phiếu · {templateLabel}
              {reviewCount > 0 && ` · ${reviewCount} cần kiểm tra`}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9CA3AF', padding: 4 }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Sheet list */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Danh sách sheet
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SheetRow name="1. Tổng quan"       included={true}           description="KPI dashboard tổng hợp" />
            <SheetRow name="2. Bảng điểm"       included={true}           description="Bảng điểm chính với tiêu đề + thống kê" />
            <SheetRow name="3. Cần kiểm tra"    included={includeReview}  description={`${reviewCount} phiếu có cảnh báo`} />
            <SheetRow name="4. Chi tiết đáp án" included={includeAnswers} description="Đáp án từng câu" />
          </div>
        </div>

        {/* Options */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Tuỳ chọn
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Checkbox checked={includeReview}   onChange={setIncludeReview}   label="Bao gồm sheet Cần kiểm tra" />
            <Checkbox checked={includeAnswers}  onChange={setIncludeAnswers}  label="Bao gồm sheet Chi tiết đáp án" />
            <Checkbox checked={highlightReview} onChange={setHighlightReview} label="Tô màu vàng các dòng cần kiểm tra" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#9CA3AF' }}>
              <CheckSquare size={16} color="#10B981" style={{ flexShrink: 0 }} />
              Giữ số 0 đầu (CCCD, SBD, Mã đề) — bật mặc định
            </div>
          </div>
        </div>

        {/* Divider */}
        <div style={{ borderTop: '1px solid #F3F4F6' }} />

        {/* Preview table */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Xem trước — {Math.min(3, results.length)} dòng đầu
          </div>
          <PreviewTable results={results} answerKey={answerKey} corrections={corrections} />
        </div>

        {/* Info note */}
        <div style={{ background: '#F9FAFB', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#6B7280' }}>
          📄 Tên file: <code style={{ fontSize: 11, color: '#374151', background: '#F3F4F6', padding: '1px 5px', borderRadius: 4 }}>
            vju_smart_grading_report_YYYYMMDD_HHmm.xlsx
          </code>
          <span style={{ marginLeft: 12 }}>· Nguồn: {dataSource}</span>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose} style={{ minWidth: 80 }}>
            Hủy
          </Button>
          <Button
            variant="primary"
            icon={<Download size={14} />}
            onClick={handleDownload}
            disabled={exporting}
            style={{ minWidth: 120, background: '#C8102E', borderColor: '#C8102E' }}
          >
            {exporting ? 'Đang xuất…' : 'Tải .xlsx'}
          </Button>
        </div>
      </div>
    </>
  );
}
