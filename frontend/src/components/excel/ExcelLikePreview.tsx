/**
 * ExcelLikePreview.tsx
 *
 * Renders an Excel-like spreadsheet table for the "Bảng điểm" sheet.
 * Includes row-number gutter, column-letter header, merged title/metadata cells,
 * VJU red column header, zebra data rows, and a dark stats footer.
 */

import type { OmrGradeResult, AnswerKeyStore, CorrectionsStore, BatchGradeState } from '../../types/grading';
import { TEMPLATE_VARIANT_LABEL, computeScore, applyCorrection } from '../../types/grading';

// ── VJU palette ───────────────────────────────────────────────────────────────

const P = {
  cream:      '#FAF7F2',
  creamLine:  '#EDE6D9',
  border:     '#D9D0C3',
  colHdrBg:   '#F0EBE2',
  colHdrTxt:  '#8A7D6B',
  rowNumBg:   '#F3EDE4',
  rowNumTxt:  '#A89880',
  titleBg:    '#252525',
  titleTxt:   '#FFFFFF',
  metaBg:     '#2B2B2B',
  metaTxt:    '#F5EDE0',
  metaLblTxt: '#C8A882',
  headerBg:   '#C8102E',
  headerTxt:  '#FFFFFF',
  rowAlt:     '#F5F0E8',
  rowNorm:    '#FFFFFF',
  footerBg:   '#1F2937',
  footerTxt:  '#FFFFFF',
  footerMuted:'#9CA3AF',
  warnBg:     '#FEF3C7',
  warnTxt:    '#92400E',
  warnRed:    '#DC2626',
  okTxt:      '#15803D',
  okBg:       '#F0FDF4',
  errBg:      '#FEF2F2',
  muted:      '#6B7280',
  dark:       '#1F2937',
} as const;

// ── Column config ─────────────────────────────────────────────────────────────

const COLS: { label: string; letter: string; width: number; align?: 'center' | 'right' }[] = [
  { label: 'STT',         letter: 'A', width: 52,  align: 'center' },
  { label: 'File',        letter: 'B', width: 195 },
  { label: 'CCCD',        letter: 'C', width: 130 },
  { label: 'SBD',         letter: 'D', width: 110 },
  { label: 'Mã đề',       letter: 'E', width: 76,  align: 'center' },
  { label: 'Ca thi',      letter: 'F', width: 76,  align: 'center' },
  { label: 'Mã CTĐT',     letter: 'G', width: 86,  align: 'center' },
  { label: 'Tự chọn',     letter: 'H', width: 76,  align: 'center' },
  { label: 'Đúng',        letter: 'I', width: 62,  align: 'center' },
  { label: 'Sai',         letter: 'J', width: 62,  align: 'center' },
  { label: 'Trống',       letter: 'K', width: 62,  align: 'center' },
  { label: 'Điểm',        letter: 'L', width: 68,  align: 'center' },
  { label: 'Trạng thái',  letter: 'M', width: 118, align: 'center' },
  { label: 'Kết quả',     letter: 'N', width: 118, align: 'center' },
];

const ROW_NUM_W = 38;
const NCOLS = COLS.length;

// ── Helpers ───────────────────────────────────────────────────────────────────

function dash(v: string | null | undefined): string {
  return v == null || v === '' ? '—' : String(v);
}

function needsReview(r: OmrGradeResult): boolean {
  return (r.warnings ?? []).length > 0 || (r.score?.blank ?? 0) > 0 || !!r._error;
}

function statusLabel(r: OmrGradeResult, corrected: boolean): string {
  if (r._error)  return 'Lỗi';
  if (corrected) return 'Đã sửa tay';
  return needsReview(r) ? 'Cần kiểm tra' : 'Đã chấm';
}

function resultLabel(r: OmrGradeResult): string {
  if (r._error) return 'LỖI';
  return needsReview(r) ? 'CẦN KIỂM TRA' : 'ĐÃ CHẤM';
}

// ── Sub-cells ─────────────────────────────────────────────────────────────────

const CELL_BASE: React.CSSProperties = {
  borderRight: `1px solid ${P.border}`,
  borderBottom: `1px solid ${P.border}`,
  padding: '0 8px',
  fontSize: 11,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
  height: 24,
  boxSizing: 'border-box',
};

// ── Main export ───────────────────────────────────────────────────────────────

export interface ExcelLikePreviewProps {
  batch:       BatchGradeState;
  results:     OmrGradeResult[];
  answerKey:   AnswerKeyStore | null;
  corrections: CorrectionsStore;
  dataSource:  string;
}

export default function ExcelLikePreview({
  batch, results, answerKey, corrections, dataSource,
}: ExcelLikePreviewProps) {
  const hasKey = !!answerKey && Object.keys(answerKey.answers ?? {}).length > 0;

  const scored = results.map(r => {
    const c = corrections[r.input?.filename ?? ''];
    const m = applyCorrection(r, c);
    const sc = hasKey ? computeScore(m.answers ?? {}, answerKey!) : null;
    return { r, merged: m, corr: c, sc };
  });

  const scores = scored.map(x => x.sc?.total ?? null).filter((s): s is number => s !== null);
  const revCount = results.filter(needsReview).length;
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 100) / 100 : null;
  const hiScore  = scores.length ? Math.max(...scores) : null;
  const loScore  = scores.length ? Math.min(...scores) : null;
  const pct      = results.length > 0 ? Math.round(revCount / results.length * 1000) / 10 : 0;

  const now = new Date();
  const dateStr = now.toLocaleString('vi-VN', { hour12: false });
  const gradedStr = new Date(batch.gradedAt).toLocaleString('vi-VN', { hour12: false });
  const templateLabel = TEMPLATE_VARIANT_LABEL[batch.templateVariant] ?? batch.templateVariant;

  // Start row numbers: title=1, meta x2=2-3, header=4, data starts=5
  const dataStartRow = 5;

  return (
    <div style={{
      overflowX: 'auto',
      background: P.cream,
      borderRadius: 10,
      border: `1px solid ${P.creamLine}`,
      boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
    }}>
      <table
        style={{
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
          fontFamily: "'Calibri', 'Segoe UI', Arial, sans-serif",
        }}
      >
        <colgroup>
          {/* Row-number gutter */}
          <col style={{ width: ROW_NUM_W }} />
          {/* Data columns */}
          {COLS.map(c => <col key={c.letter} style={{ width: c.width }} />)}
        </colgroup>

        <thead>
          {/* ── Column letter header ───────────────────────────────────────── */}
          <tr style={{ height: 22 }}>
            {/* Corner cell */}
            <th style={{
              ...CELL_BASE,
              background: P.colHdrBg,
              borderBottom: `2px solid ${P.border}`,
              borderRight: `2px solid ${P.border}`,
              position: 'sticky', top: 0, left: 0, zIndex: 20,
            }} />
            {COLS.map(c => (
              <th key={c.letter} style={{
                ...CELL_BASE,
                background: P.colHdrBg,
                color: P.colHdrTxt,
                fontWeight: 700,
                fontSize: 11,
                textAlign: 'center',
                borderBottom: `2px solid ${P.border}`,
                position: 'sticky', top: 0, zIndex: 10,
                letterSpacing: '0.03em',
              }}>
                {c.letter}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {/* ── Row 1: Title merged ────────────────────────────────────────── */}
          <tr style={{ height: 52 }}>
            <RowNum n={1} />
            <td colSpan={NCOLS} style={{
              ...CELL_BASE,
              height: 52,
              background: P.titleBg,
              color: P.titleTxt,
              textAlign: 'center',
              verticalAlign: 'middle',
              overflow: 'visible',
              whiteSpace: 'normal',
              padding: '4px 20px',
            }}>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '0.02em', lineHeight: 1.3 }}>
                TRƯỜNG ĐẠI HỌC VIỆT NHẬT (VJU)
              </div>
              <div style={{ fontSize: 11, fontWeight: 400, color: '#C8A882', marginTop: 2, letterSpacing: '0.04em' }}>
                BẢNG KẾT QUẢ CHẤM PHIẾU TRẮC NGHIỆM
              </div>
            </td>
          </tr>

          {/* ── Row 2: Metadata left+right ────────────────────────────────── */}
          <MetaRow
            rowN={2}
            left={[`Mẫu phiếu: ${templateLabel}`, `Số phiếu: ${results.length}`]}
            right={[`Thời gian chấm: ${gradedStr}`, `Nguồn dữ liệu: ${dataSource}`]}
            ncols={NCOLS}
          />

          {/* ── Row 3: Second metadata row ────────────────────────────────── */}
          <MetaRow
            rowN={3}
            left={[`Ngày xuất: ${dateStr}`, '']}
            right={[`Cần kiểm tra: ${revCount} phiếu`, hasKey ? `Điểm TB: ${avgScore ?? '—'}` : 'Answer Key: chưa nhập']}
            ncols={NCOLS}
          />

          {/* ── Row 4: Spacer ─────────────────────────────────────────────── */}
          <tr style={{ height: 6 }}>
            <td style={{ background: P.cream, borderRight: `1px solid ${P.border}` }} />
            <td colSpan={NCOLS} style={{ background: P.cream }} />
          </tr>

          {/* ── Row 5: Column header (VJU red) ────────────────────────────── */}
          <tr style={{ height: 32 }}>
            <RowNum n={4} />
            {COLS.map(c => (
              <th key={c.letter} style={{
                ...CELL_BASE,
                height: 32,
                background: P.headerBg,
                color: P.headerTxt,
                fontWeight: 700,
                textAlign: c.align ?? 'left',
                fontSize: 11,
                letterSpacing: '0.01em',
                position: 'sticky', top: 22,
                borderBottom: `2px solid #9B0C22`,
              }}>
                {c.label}
              </th>
            ))}
          </tr>

          {/* ── Data rows ─────────────────────────────────────────────────── */}
          {scored.map(({ r, merged, corr, sc }, i) => {
            const info      = merged.student_info ?? r.student_info ?? {};
            const corrected = !!corr;
            const review    = needsReview(r);
            const isAlt     = i % 2 === 1;
            const rowBg     = r._error ? P.errBg : corrected ? '#F8FFF8' : isAlt ? P.rowAlt : P.rowNorm;

            return (
              <tr key={r.db_id ?? r.input?.filename ?? i} style={{ height: 26, background: rowBg }}>
                <RowNum n={dataStartRow + i} />
                {/* A: STT */}
                <td style={{ ...CELL_BASE, textAlign: 'center', color: P.muted }}>{i + 1}</td>
                {/* B: File */}
                <td style={{ ...CELL_BASE, color: P.dark, fontWeight: 500, fontSize: 10 }}
                  title={r.input?.filename ?? '—'}>
                  {dash(r.input?.filename)}
                </td>
                {/* C: CCCD */}
                <td style={{ ...CELL_BASE, fontFamily: 'monospace', color: '#C8102E', fontWeight: 600, letterSpacing: '0.02em' }}>
                  {dash(info.cccd)}
                </td>
                {/* D: SBD */}
                <td style={{ ...CELL_BASE, fontFamily: 'monospace', letterSpacing: '0.02em' }}>
                  {dash(info.sbd)}
                </td>
                {/* E: Mã đề */}
                <td style={{ ...CELL_BASE, textAlign: 'center', fontFamily: 'monospace' }}>
                  {dash(info.ma_de)}
                </td>
                {/* F: Ca thi */}
                <td style={{ ...CELL_BASE, textAlign: 'center' }}>
                  {dash(info.ca_thi)}
                </td>
                {/* G: Mã CTĐT */}
                <td style={{ ...CELL_BASE, textAlign: 'center', fontFamily: 'monospace' }}>
                  {dash(info.ma_ctdt)}
                </td>
                {/* H: Tự chọn */}
                <td style={{ ...CELL_BASE, textAlign: 'center', fontFamily: 'monospace' }}>
                  {dash(info.tu_chon)}
                </td>
                {/* I-K: Đúng/Sai/Trống */}
                <td style={{ ...CELL_BASE, textAlign: 'center', color: '#15803D', fontWeight: 600 }}>
                  {sc ? sc.correct : '—'}
                </td>
                <td style={{ ...CELL_BASE, textAlign: 'center', color: '#DC2626', fontWeight: 600 }}>
                  {sc ? sc.wrong : '—'}
                </td>
                <td style={{ ...CELL_BASE, textAlign: 'center', color: P.muted }}>
                  {sc ? sc.blank : '—'}
                </td>
                {/* L: Điểm */}
                <td style={{ ...CELL_BASE, textAlign: 'center', fontWeight: 800, fontSize: 12, color: P.dark }}>
                  {sc ? sc.total : '—'}
                </td>
                {/* M: Trạng thái */}
                <td style={{
                  ...CELL_BASE, textAlign: 'center',
                  background: corrected ? '#D1FAE5' : review ? P.warnBg : undefined,
                  color:      corrected ? P.okTxt   : review ? P.warnTxt : P.dark,
                  fontWeight: review || corrected ? 600 : 400,
                }}>
                  {statusLabel(r, corrected)}
                </td>
                {/* N: Kết quả */}
                <td style={{
                  ...CELL_BASE, textAlign: 'center', fontWeight: 700, fontSize: 10,
                  letterSpacing: '0.03em',
                  background: r._error ? P.errBg : review ? P.warnBg : P.okBg,
                  color:      r._error ? P.warnRed : review ? P.warnRed : P.okTxt,
                }}>
                  {resultLabel(r)}
                </td>
              </tr>
            );
          })}

          {/* ── Gap before footer ─────────────────────────────────────────── */}
          <tr style={{ height: 10 }}>
            <td style={{ background: P.cream, borderRight: `1px solid ${P.border}` }} />
            <td colSpan={NCOLS} style={{ background: P.cream }} />
          </tr>

          {/* ── Footer: THỐNG KÊ TỔNG ────────────────────────────────────── */}
          <tr style={{ height: 30 }}>
            <RowNum n={dataStartRow + results.length + 1} dark />
            <td colSpan={NCOLS} style={{
              ...CELL_BASE,
              height: 30,
              background: P.footerBg,
              color: P.footerTxt,
              fontWeight: 800,
              fontSize: 12,
              letterSpacing: '0.06em',
              textAlign: 'left',
              paddingLeft: 16,
            }}>
              THỐNG KÊ TỔNG
            </td>
          </tr>

          {/* Footer stats rows */}
          {[
            ['Tổng phiếu',             results.length],
            ['Phiếu có điểm',          scores.length],
            ['Cần kiểm tra',           revCount],
            ['Tỷ lệ cần kiểm tra',     `${pct}%`],
            ...(hasKey ? [
              ['Điểm trung bình', avgScore ?? '—'],
              ['Điểm cao nhất',   hiScore  ?? '—'],
              ['Điểm thấp nhất',  loScore  ?? '—'],
            ] : []),
          ].map(([label, value], i) => (
            <tr key={i} style={{ height: 24, background: i % 2 === 0 ? P.footerBg : '#2D3748' }}>
              <RowNum n={dataStartRow + results.length + 2 + i} dark />
              <td style={{ ...CELL_BASE, background: 'inherit', color: P.footerMuted, paddingLeft: 16 }}>
                {String(label)}
              </td>
              <td colSpan={NCOLS - 1} style={{
                ...CELL_BASE, background: 'inherit',
                color: P.footerTxt, fontWeight: 700,
              }}>
                {String(value)}
              </td>
            </tr>
          ))}

          {/* Bottom padding row */}
          <tr style={{ height: 20 }}>
            <td colSpan={NCOLS + 1} style={{ background: P.cream }} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── RowNum cell ────────────────────────────────────────────────────────────────

function RowNum({ n, dark = false }: { n: number; dark?: boolean }) {
  return (
    <td style={{
      width: ROW_NUM_W,
      background: dark ? '#1A2030' : P.rowNumBg,
      color: dark ? '#6B7280' : P.rowNumTxt,
      textAlign: 'center',
      fontSize: 10,
      fontWeight: 500,
      borderRight: `2px solid ${dark ? '#374151' : P.border}`,
      borderBottom: `1px solid ${dark ? '#374151' : P.border}`,
      userSelect: 'none',
      paddingRight: 4,
      verticalAlign: 'middle',
      height: 24,
    }}>
      {n}
    </td>
  );
}

// ── MetaRow ────────────────────────────────────────────────────────────────────

function MetaRow({ rowN, left, right, ncols }: {
  rowN:  number;
  left:  [string, string];
  right: [string, string];
  ncols: number;
}) {
  const half = Math.floor(ncols / 2);
  return (
    <tr style={{ height: 26 }}>
      <RowNum n={rowN} />
      <td colSpan={half} style={{
        ...CELL_BASE,
        height: 26,
        background: P.metaBg,
        color: P.metaTxt,
        fontSize: 11,
        paddingLeft: 14,
      }}>
        <MetaInline pairs={left} />
      </td>
      <td colSpan={ncols - half} style={{
        ...CELL_BASE,
        height: 26,
        background: P.metaBg,
        color: P.metaTxt,
        fontSize: 11,
        paddingLeft: 14,
      }}>
        <MetaInline pairs={right} />
      </td>
    </tr>
  );
}

function MetaInline({ pairs }: { pairs: [string, string] }) {
  return (
    <span>
      {pairs[0] && (
        <span>
          <span style={{ color: P.metaLblTxt, marginRight: 4 }}>
            {pairs[0].split(':')[0]}:
          </span>
          <span style={{ color: '#F5EDE0', fontWeight: 600 }}>
            {pairs[0].includes(':') ? pairs[0].split(':').slice(1).join(':').trim() : ''}
          </span>
        </span>
      )}
      {pairs[1] && (
        <span style={{ marginLeft: 24 }}>
          <span style={{ color: P.metaLblTxt, marginRight: 4 }}>
            {pairs[1].split(':')[0]}:
          </span>
          <span style={{ color: '#F5EDE0', fontWeight: 600 }}>
            {pairs[1].includes(':') ? pairs[1].split(':').slice(1).join(':').trim() : ''}
          </span>
        </span>
      )}
    </span>
  );
}
