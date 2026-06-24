/**
 * exportResultsExcel.ts — VJU Smart Grading · Official Grade Report
 *
 * Sheet order:
 *   1. Tổng quan        — KPI dashboard
 *   2. Bảng điểm        — main grade table with title block + summary footer
 *   3. Cần kiểm tra     — review rows with wrapped detail
 *   4. Chi tiết đáp án  — per-question answers
 *
 * Deps: exceljs, file-saver
 */

import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import type {
  OmrGradeResult,
  AnswerKeyStore,
  CorrectionsStore,
  BatchGradeState,
} from '../types/grading';
import { computeScore, applyCorrection, TEMPLATE_VARIANT_LABEL } from '../types/grading';

// ── Colours ───────────────────────────────────────────────────────────────────

const C = {
  red:       'C8102E',
  redDark:   '9B0C22',
  redLight:  'FEECEC',
  white:     'FFFFFF',
  dark:      '1F2937',
  muted:     '6B7280',
  headerBg:  'F3F4F6',
  rowAlt:    'F9FAFB',
  border:    'D1D5DB',
  footerBg:  '374151',
  footerTxt: 'FFFFFF',
  warnBg:    'FEF3C7',
  warnTxt:   '92400E',
  okBg:      'D1FAE5',
  okTxt:     '065F46',
  errBg:     'FEE2E2',
  errTxt:    'DC2626',
  metaBg:    'FFF9F9',
  metaBdr:   'FECACA',
} as const;

// ── Low-level helpers ─────────────────────────────────────────────────────────

type Cell = ExcelJS.Cell;
type Row  = ExcelJS.Row;

function fill(cell: Cell, argb: string) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function fnt(cell: Cell, opts: {
  bold?: boolean; color?: string; size?: number; italic?: boolean;
}) {
  cell.font = {
    name: 'Calibri', bold: opts.bold ?? false, italic: opts.italic ?? false,
    size: opts.size ?? 11,
    color: opts.color ? { argb: opts.color } : undefined,
  };
}

function bdr(cell: Cell, color = C.border) {
  const s: ExcelJS.BorderStyle = 'thin';
  const c = { style: s, color: { argb: color } };
  cell.border = { top: c, bottom: c, left: c, right: c };
}

function aln(cell: Cell, h: ExcelJS.Alignment['horizontal'] = 'left', wrap = false) {
  cell.alignment = { horizontal: h, vertical: 'middle', wrapText: wrap };
}

/** Write value as inline string — Excel preserves leading zeros */
function txt(cell: Cell, value: string | null | undefined) {
  const s = value == null || value === '' ? '—' : String(value);
  cell.value = { richText: [{ text: s, font: { name: 'Calibri', size: 11 } }] };
}

function dash(v: unknown): string {
  return (v == null || v === '') ? '—' : String(v);
}

// ── Style row helpers ─────────────────────────────────────────────────────────

function styleVjuHeader(row: Row, numCols: number) {
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    fill(cell, C.red);
    fnt(cell, { bold: true, color: C.white, size: 11 });
    aln(cell, 'center');
    bdr(cell);
  }
  row.height = 30;
}

function styleDataRow(row: Row, numCols: number, isAlt: boolean) {
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    if (isAlt) fill(cell, C.rowAlt);
    aln(cell, 'left');
    bdr(cell);
  }
  row.height = 22;
}

function styleFooter(row: Row, numCols: number) {
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    fill(cell, C.footerBg);
    fnt(cell, { bold: true, color: C.footerTxt, size: 11 });
    aln(cell, 'center');
    bdr(cell, 'FFFFFF');
  }
  row.height = 26;
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function needsReview(r: OmrGradeResult): boolean {
  return (r.warnings ?? []).length > 0 || (r.score?.blank ?? 0) > 0 || !!r._error;
}

function statusLabel(r: OmrGradeResult, corrected: boolean): string {
  if (r._error)  return 'Lỗi';
  if (corrected) return 'Đã sửa tay';
  return needsReview(r) ? 'Cần kiểm tra' : 'Đã chấm';
}

function lyrDo(r: OmrGradeResult): string {
  if (r._error) return 'Lỗi chấm phiếu';
  const warns = r.warnings ?? [];
  const blank = r.score?.blank ?? 0;
  const p: string[] = [];
  if (warns.some(w => w.type === 'multi_mark'))            p.push('Multi-mark MCQ');
  if (warns.some(w => w.type === 'multi_mark_info_field')) p.push('Thông tin thí sinh không chắc chắn');
  if (blank > 0)                                           p.push(`${blank} câu bỏ trống`);
  if (warns.some(w => w.type === 'too_light'))             p.push('Nét tô mờ');
  return p.join('; ') || 'Cần kiểm tra';
}

function chiTietCanhBao(r: OmrGradeResult): string {
  if (r._error) return `Lỗi: ${r._error}`;
  const warns = r.warnings ?? [];
  const blank = r.score?.blank ?? 0;
  const lines: string[] = [];
  if (blank > 0) lines.push(`- Số câu trống: ${blank}`);
  const mm  = warns.filter(w => w.type === 'multi_mark').map(w => w.field);
  const mmi = warns.filter(w => w.type === 'multi_mark_info_field').map(w => `${w.field}${w.column ? '/' + w.column : ''}`);
  const tl  = warns.filter(w => w.type === 'too_light').map(w => w.field);
  if (mm.length)  lines.push(`- Multi-mark MCQ: ${mm.join(', ')}`);
  if (mmi.length) lines.push(`- Multi-mark thông tin: ${mmi.join(', ')}`);
  if (tl.length)  lines.push(`- Nét mờ: ${tl.join(', ')}`);
  return lines.join('\n') || '—';
}

function collectAnswerKeys(results: OmrGradeResult[]): string[] {
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

function autoWidth(ws: ExcelJS.Worksheet, max = 40) {
  ws.columns.forEach(col => {
    if (!col?.eachCell) return;
    let w = 8;
    col.eachCell({ includeEmpty: false }, cell => {
      const v = cell.value;
      const len = v !== null && v !== undefined ? String(v).length : 0;
      if (len > w) w = len;
    });
    col.width = Math.min(w + 3, max);
  });
}

// ── Sheet 1: Tổng quan ────────────────────────────────────────────────────────

function buildTongQuan(
  wb: ExcelJS.Workbook,
  batch: BatchGradeState,
  results: OmrGradeResult[],
  answerKey: AnswerKeyStore | null,
  corrections: CorrectionsStore,
  dataSource: string,
) {
  const ws = wb.addWorksheet('Tổng quan');
  ws.columns = [
    { width: 26 }, { width: 30 }, { width: 6 },
    { width: 18 }, { width: 16 }, { width: 6 }, { width: 6 }, { width: 6 },
  ];

  // Title
  ws.mergeCells('A1:H1');
  const t1 = ws.getCell('A1');
  t1.value = 'VJU SMART GRADING — TỔNG QUAN KẾT QUẢ';
  fill(t1, C.red); fnt(t1, { bold: true, color: C.white, size: 16 }); aln(t1, 'center');
  ws.getRow(1).height = 46;

  ws.mergeCells('A2:H2');
  const t2 = ws.getCell('A2');
  t2.value = 'Vietnam Japan University · Báo cáo chấm phiếu trắc nghiệm tự động';
  fill(t2, C.redDark); fnt(t2, { italic: true, color: C.white, size: 11 }); aln(t2, 'center');
  ws.getRow(2).height = 24;
  ws.getRow(3).height = 10;

  // Compute KPIs
  const scored = results.map(r => {
    const c = corrections[r.input?.filename ?? ''];
    const m = applyCorrection(r, c);
    return answerKey ? computeScore(m.answers ?? {}, answerKey) : null;
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  const total    = results.length;
  const withSc   = scored.length;
  const revCnt   = results.filter(needsReview).length;
  const corrCnt  = Object.keys(corrections).length;
  const okCnt    = total - revCnt;
  const avg      = withSc ? Math.round(scored.reduce((a, b) => a + b.total, 0) / withSc * 100) / 100 : null;
  const hi       = withSc ? Math.max(...scored.map(s => s.total)) : null;
  const lo       = withSc ? Math.min(...scored.map(s => s.total)) : null;

  // Info block header
  ws.mergeCells('A4:B4');
  const ih = ws.getRow(4).getCell(1);
  ih.value = 'THÔNG TIN ĐỢT CHẤM';
  fill(ih, C.red); fnt(ih, { bold: true, color: C.white, size: 11 }); aln(ih, 'left');
  ws.getRow(4).height = 26;

  const info: [string, string | number][] = [
    ['Template',         batch.templateMode === 'custom' ? (batch.customTemplateName ? `Custom: ${batch.customTemplateName}` : 'Custom template') : (TEMPLATE_VARIANT_LABEL[batch.templateVariant] ?? batch.templateVariant)],
    ['Thời gian chấm',   new Date(batch.gradedAt).toLocaleString('vi-VN', { hour12: false })],
    ['Thời gian xuất',   new Date().toLocaleString('vi-VN', { hour12: false })],
    ['Nguồn dữ liệu',    dataSource],
  ];
  info.forEach(([lbl, val], i) => {
    const row = ws.getRow(5 + i);
    row.getCell(1).value = lbl; row.getCell(2).value = val;
    fnt(row.getCell(1), { bold: true, color: C.muted });
    fnt(row.getCell(2), { color: C.dark });
    if (i % 2) { fill(row.getCell(1), C.rowAlt); fill(row.getCell(2), C.rowAlt); }
    bdr(row.getCell(1)); bdr(row.getCell(2));
    row.height = 22;
  });

  ws.getRow(9).height = 10;

  // Stats block header
  ws.mergeCells('A10:B10');
  const sh = ws.getRow(10).getCell(1);
  sh.value = 'CHỈ SỐ KẾT QUẢ';
  fill(sh, C.red); fnt(sh, { bold: true, color: C.white, size: 11 }); aln(sh, 'left');
  ws.getRow(10).height = 26;

  const stats: [string, string | number, string][] = [
    ['Tổng phiếu',                total,    C.white],
    ['Phiếu có điểm',             withSc,   C.white],
    ['Đã chấm (không lỗi)',        okCnt,    C.okBg],
    ['Cần kiểm tra',              revCnt,   C.warnBg],
    ['Đã sửa tay',                corrCnt,  C.okBg],
    ['Điểm trung bình',           avg  ?? '—', C.white],
    ['Điểm cao nhất',             hi   ?? '—', C.white],
    ['Điểm thấp nhất',            lo   ?? '—', C.white],
  ];
  stats.forEach(([lbl, val, bg], i) => {
    const row = ws.getRow(11 + i);
    row.getCell(1).value = lbl;
    row.getCell(2).value = val;
    fnt(row.getCell(1), { bold: false, color: C.dark });
    fnt(row.getCell(2), { bold: true,  color: C.dark, size: 12 });
    if (i % 2 && bg === C.white) fill(row.getCell(1), C.rowAlt);
    if (bg !== C.white) { fill(row.getCell(1), bg); fill(row.getCell(2), bg); }
    aln(row.getCell(2), 'center');
    bdr(row.getCell(1)); bdr(row.getCell(2));
    row.height = 22;
  });

  ws.getRow(19).height = 10;
  ws.mergeCells('A20:H20');
  const note = ws.getRow(20).getCell(1);
  note.value = '⚠️  Các phiếu có trạng thái "Cần kiểm tra" nên được review trước khi sử dụng kết quả chính thức.';
  fill(note, C.warnBg);
  fnt(note, { italic: true, color: C.warnTxt, size: 11 });
  note.alignment = { wrapText: true, vertical: 'middle' };
  ws.getRow(20).height = 34;
}

// ── Sheet 2: Bảng điểm ───────────────────────────────────────────────────────

const BANG_DIEM_HEADERS = [
  'STT', 'File', 'SBD', 'CCCD', 'Mã đề', 'Ca thi', 'Mã CTĐT', 'Tự chọn',
  'Đúng', 'Sai', 'Trống', 'Điểm', 'Trạng thái', 'Cần xem lại',
];
const BANG_NCOLS = BANG_DIEM_HEADERS.length;
const MERGE_END  = String.fromCharCode(64 + BANG_NCOLS); // e.g. 'N'

function buildBangDiem(
  wb: ExcelJS.Workbook,
  batch: BatchGradeState,
  results: OmrGradeResult[],
  answerKey: AnswerKeyStore | null,
  corrections: CorrectionsStore,
  dataSource: string,
  opts: ExportOptions,
) {
  const ws = wb.addWorksheet('Bảng điểm');

  ws.columns = [
    { width: 6  }, // STT
    { width: 28 }, // File
    { width: 14 }, // SBD
    { width: 20 }, // CCCD
    { width: 10 }, // Mã đề
    { width: 10 }, // Ca thi
    { width: 12 }, // Mã CTĐT
    { width: 10 }, // Tự chọn
    { width: 8  }, // Đúng
    { width: 8  }, // Sai
    { width: 8  }, // Trống
    { width: 10 }, // Điểm
    { width: 16 }, // Trạng thái
    { width: 14 }, // Cần xem lại
  ];

  // ── Title block ──────────────────────────────────────────────────────────
  ws.mergeCells(`A1:${MERGE_END}1`);
  const t1 = ws.getCell('A1');
  t1.value = 'TRƯỜNG ĐẠI HỌC VIỆT NHẬT (VJU)';
  fill(t1, C.red); fnt(t1, { bold: true, color: C.white, size: 18 }); aln(t1, 'center');
  ws.getRow(1).height = 50;

  ws.mergeCells(`A2:${MERGE_END}2`);
  const t2 = ws.getCell('A2');
  t2.value = 'BẢNG KẾT QUẢ CHẤM PHIẾU TRẮC NGHIỆM';
  fill(t2, C.redDark); fnt(t2, { bold: true, color: C.white, size: 14 }); aln(t2, 'center');
  ws.getRow(2).height = 36;

  // ── Metadata block ───────────────────────────────────────────────────────
  const meta: [string, string][] = [
    ['Mẫu phiếu',       batch.templateMode === 'custom' ? (batch.customTemplateName ? `Custom: ${batch.customTemplateName}` : 'Custom template') : (TEMPLATE_VARIANT_LABEL[batch.templateVariant] ?? batch.templateVariant)],
    ['Thời gian chấm',  new Date(batch.gradedAt).toLocaleString('vi-VN', { hour12: false })],
    ['Thời gian xuất',  new Date().toLocaleString('vi-VN', { hour12: false })],
    ['Nguồn dữ liệu',   dataSource],
  ];

  const halfN = Math.ceil(BANG_NCOLS / 2);
  const midCol = String.fromCharCode(64 + halfN);
  const endCol = MERGE_END;

  meta.forEach(([lbl, val], i) => {
    const r = 3 + i;
    if (i < 2) {
      // Left column pair
      ws.mergeCells(`A${r}:${midCol}${r}`);
      const cell = ws.getCell(`A${r}`);
      cell.value = `${lbl}: ${val}`;
      fill(cell, C.metaBg);
      fnt(cell, { color: C.dark, size: 11 });
      bdr(cell);
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      // Right column pair (rows 3-4 right side)
      const row3or4 = r - 2 + 3;
      ws.mergeCells(`${String.fromCharCode(64 + halfN + 1)}${row3or4}:${endCol}${row3or4}`);
      const cell2 = ws.getCell(`${String.fromCharCode(64 + halfN + 1)}${row3or4}`);
      cell2.value = `${lbl}: ${val}`;
      fill(cell2, C.metaBg);
      fnt(cell2, { color: C.dark, size: 11 });
      bdr(cell2);
      cell2.alignment = { vertical: 'middle', horizontal: 'left' };
    }
    ws.getRow(r).height = 22;
  });
  // row 3 & 4 already set; spacer
  ws.getRow(5).height = 8;

  // ── Table header (frozen at row 6) ───────────────────────────────────────
  const TABLE_START = 6;
  ws.views = [{ state: 'frozen', ySplit: TABLE_START }];
  const hRow = ws.getRow(TABLE_START);
  hRow.values = BANG_DIEM_HEADERS;
  styleVjuHeader(hRow, BANG_NCOLS);
  ws.autoFilter = { from: { row: TABLE_START, column: 1 }, to: { row: TABLE_START, column: BANG_NCOLS } };

  // ── Data rows ────────────────────────────────────────────────────────────
  results.forEach((r, i) => {
    const fname   = r.input?.filename ?? '';
    const corr    = corrections[fname];
    const merged  = applyCorrection(r, corr);
    const sc      = answerKey ? computeScore(merged.answers ?? {}, answerKey) : null;
    const info    = merged.student_info ?? r.student_info ?? {};
    const isCorrected = !!corr;
    const review  = needsReview(r);
    const isAlt   = i % 2 === 1;

    const row = ws.getRow(TABLE_START + 1 + i);
    row.getCell(1).value  = i + 1;
    row.getCell(2).value  = dash(fname);
    txt(row.getCell(3),  info.sbd);
    txt(row.getCell(4),  info.cccd);
    txt(row.getCell(5),  info.ma_de);
    txt(row.getCell(6),  info.ca_thi);
    txt(row.getCell(7),  info.ma_ctdt);
    txt(row.getCell(8),  info.tu_chon);
    row.getCell(9).value  = sc ? sc.correct : '—';
    row.getCell(10).value = sc ? sc.wrong   : '—';
    row.getCell(11).value = sc ? sc.blank   : '—';
    row.getCell(12).value = sc ? sc.total   : '—';
    row.getCell(13).value = statusLabel(r, isCorrected);
    row.getCell(14).value = review ? 'Có' : 'Không';

    styleDataRow(row, BANG_NCOLS, isAlt);

    // Điểm: bold + center
    aln(row.getCell(12), 'center');
    fnt(row.getCell(12), { bold: true, color: C.dark });

    // File: wrap
    row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };

    // Cần xem lại: yellow
    if (opts.highlightReview && review) {
      fill(row.getCell(14), C.warnBg);
      fnt(row.getCell(14), { bold: true, color: C.warnTxt });
    }
    // Đã sửa: green status
    if (isCorrected) {
      fill(row.getCell(13), C.okBg);
      fnt(row.getCell(13), { color: C.okTxt });
    }
    // Error: red tint
    if (r._error) for (let c = 1; c <= BANG_NCOLS; c++) fill(row.getCell(c), C.errBg);

    row.height = 22;
  });

  // ── Summary footer ───────────────────────────────────────────────────────
  const scored = results.map(r => {
    const c = corrections[r.input?.filename ?? ''];
    const m = applyCorrection(r, c);
    return answerKey ? computeScore(m.answers ?? {}, answerKey) : null;
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  const total   = results.length;
  const revCnt  = results.filter(needsReview).length;
  const avg     = scored.length ? Math.round(scored.reduce((a, b) => a + b.total, 0) / scored.length * 100) / 100 : null;
  const hi      = scored.length ? Math.max(...scored.map(s => s.total)) : null;
  const lo      = scored.length ? Math.min(...scored.map(s => s.total)) : null;
  const pct     = total > 0 ? Math.round(revCnt / total * 1000) / 10 : 0;

  const footerData: [string, string | number][] = [
    ['THỐNG KÊ TỔNG',     ''],
    ['Tổng phiếu',         total],
    ['Điểm trung bình',    avg  ?? '—'],
    ['Cao nhất',           hi   ?? '—'],
    ['Thấp nhất',          lo   ?? '—'],
    ['Cần kiểm tra',       revCnt],
    ['Tỷ lệ cần kiểm tra', `${pct}%`],
  ];

  const footerStartRow = TABLE_START + 1 + results.length + 1; // blank gap
  ws.getRow(footerStartRow - 1).height = 8;

  footerData.forEach(([lbl, val], i) => {
    const row = ws.getRow(footerStartRow + i);
    if (i === 0) {
      // Section label spanning full width
      ws.mergeCells(`A${footerStartRow}:${MERGE_END}${footerStartRow}`);
      const cell = row.getCell(1);
      cell.value = 'THỐNG KÊ TỔNG';
      fill(cell, C.footerBg);
      fnt(cell, { bold: true, color: C.footerTxt, size: 12 });
      aln(cell, 'center');
      row.height = 28;
      return;
    }
    row.getCell(1).value = lbl;
    row.getCell(2).value = val;
    styleFooter(row, 2);
    fnt(row.getCell(1), { bold: false, color: C.footerTxt, size: 11 });
    fnt(row.getCell(2), { bold: true,  color: C.footerTxt, size: 12 });
    aln(row.getCell(2), 'center');
    row.height = 24;
  });
}

// ── Sheet 3: Cần kiểm tra ────────────────────────────────────────────────────

function buildCanKiemTra(
  wb: ExcelJS.Workbook,
  results: OmrGradeResult[],
  answerKey: AnswerKeyStore | null,
  corrections: CorrectionsStore,
) {
  const ws = wb.addWorksheet('Cần kiểm tra');
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const headers = ['STT','File','SBD','CCCD','Mã đề','Điểm','Lý do cần kiểm tra','Chi tiết cảnh báo','Gợi ý xử lý'];
  ws.columns = [
    { width: 6  }, { width: 28 }, { width: 14 }, { width: 20 }, { width: 10 },
    { width: 9  }, { width: 30 }, { width: 52 }, { width: 52 },
  ];

  const hRow = ws.getRow(1);
  hRow.values = headers;
  styleVjuHeader(hRow, headers.length);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  const reviewRows = results.filter(needsReview);
  if (reviewRows.length === 0) {
    ws.mergeCells('A2:I2');
    const cell = ws.getRow(2).getCell(1);
    cell.value = '✓  Không có phiếu nào cần kiểm tra.';
    fill(cell, C.okBg); fnt(cell, { bold: true, color: C.okTxt }); aln(cell, 'center');
    ws.getRow(2).height = 28;
    return;
  }

  reviewRows.forEach((r, i) => {
    const fname = r.input?.filename ?? '';
    const corr  = corrections[fname];
    const merged = applyCorrection(r, corr);
    const sc    = answerKey ? computeScore(merged.answers ?? {}, answerKey) : null;
    const info  = merged.student_info ?? r.student_info ?? {};

    const row   = ws.getRow(2 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = dash(fname);
    txt(row.getCell(3), info.sbd);
    txt(row.getCell(4), info.cccd);
    txt(row.getCell(5), info.ma_de);
    row.getCell(6).value = sc ? sc.total : '—';
    row.getCell(7).value = lyrDo(r);
    row.getCell(8).value = chiTietCanhBao(r);
    row.getCell(9).value = 'Mở màn hình Kiểm tra lỗi để đối chiếu ảnh gốc và ảnh detect trước khi sử dụng kết quả.';

    styleDataRow(row, headers.length, i % 2 === 1);
    aln(row.getCell(6), 'center'); fnt(row.getCell(6), { bold: true, color: C.dark });
    fill(row.getCell(7), C.warnBg); fnt(row.getCell(7), { color: C.warnTxt });
    row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
    row.getCell(8).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(9).alignment = { wrapText: true, vertical: 'top' };
    fnt(row.getCell(9), { italic: true, color: C.muted });
    row.height = 44;
  });
}

// ── Sheet 4: Chi tiết đáp án ─────────────────────────────────────────────────

function buildChiTietDapAn(
  wb: ExcelJS.Workbook,
  results: OmrGradeResult[],
  corrections: CorrectionsStore,
  answerCols: string[],
) {
  const ws = wb.addWorksheet('Chi tiết đáp án');
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const fixed   = ['STT', 'File', 'SBD', 'Mã đề'];
  const headers = [...fixed, ...answerCols.map((_, i) => `Câu ${i + 1}`)];
  ws.columns = [
    { width: 6  }, { width: 28 }, { width: 14 }, { width: 10 },
    ...answerCols.map(() => ({ width: 8 })),
  ];

  const hRow = ws.getRow(1);
  hRow.values = headers;
  styleVjuHeader(hRow, headers.length);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  results.forEach((r, i) => {
    const fname   = r.input?.filename ?? '';
    const corr    = corrections[fname];
    const merged  = applyCorrection(r, corr);
    const info    = merged.student_info ?? r.student_info ?? {};
    const answers = merged.answers ?? {};

    const row = ws.getRow(2 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = dash(fname);
    txt(row.getCell(3), info.sbd);
    txt(row.getCell(4), info.ma_de);
    answerCols.forEach((key, ci) => {
      const v = answers[key];
      row.getCell(5 + ci).value = (v == null || v === '') ? '—' : String(v);
    });

    styleDataRow(row, headers.length, i % 2 === 1);
    row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
    for (let ci = 0; ci < answerCols.length; ci++) aln(row.getCell(5 + ci), 'center');
    row.height = 22;
  });

  autoWidth(ws, 30);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ExportOptions {
  batch:             BatchGradeState;
  results:           OmrGradeResult[];
  answerKey:         AnswerKeyStore | null;
  corrections:       CorrectionsStore;
  dataSource?:       string;
  examName?:         string | null;   // used in filename
  includeReview?:    boolean;   // default true
  includeAnswers?:   boolean;   // default true
  highlightReview?:  boolean;   // default true
}

export async function exportResultsExcel(opts: ExportOptions): Promise<void> {
  const {
    batch, results, answerKey, corrections,
    dataSource = 'Không rõ',
    examName   = null,
    includeReview  = true,
    includeAnswers = true,
    highlightReview = true,
  } = opts;

  if (!results || results.length === 0) {
    alert('Chưa có kết quả để xuất Excel.');
    return;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'VJU Smart Grading';
  wb.created = wb.modified = new Date();

  const answerCols = collectAnswerKeys(results);

  buildTongQuan(wb, batch, results, answerKey, corrections, dataSource);
  buildBangDiem(wb, batch, results, answerKey, corrections, dataSource, { ...opts, highlightReview });
  if (includeReview)  buildCanKiemTra(wb, results, answerKey, corrections);
  if (includeAnswers) buildChiTietDapAn(wb, results, corrections, answerCols);

  const now = new Date();
  const p   = (n: number) => String(n).padStart(2, '0');
  const ts  = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;

  const examSlug = examName ?? batch.examName
    ? '_' + (examName ?? batch.examName!).replace(/[^a-zA-Z0-9À-ỹ]/g, '_').replace(/_+/g, '_').slice(0, 30)
    : '';
  const buf = await wb.xlsx.writeBuffer();
  saveAs(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `vju_smart_grading${examSlug}_${ts}.xlsx`,
  );
}
