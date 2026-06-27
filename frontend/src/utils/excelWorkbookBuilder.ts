/**
 * excelWorkbookBuilder.ts — Single source of truth for VJU grade report workbook.
 *
 * Exports:
 *   buildResultsWorkbook(opts) → ExcelJS.Workbook
 *   buildWorkbookDisplay(wb)   → WorkbookDisplay   (for HTML preview)
 *
 * Sheet order:
 *   1. Tổng quan       — KPI dashboard
 *   2. Bảng điểm       — main grade table with title block + summary footer
 *   3. Cần kiểm tra    — review rows with wrapped detail
 *   4. Chi tiết đáp án — per-question answers
 */

import ExcelJS from 'exceljs';
import type {
  OmrGradeResult,
  AnswerKeyStore,
  CorrectionsStore,
  BatchGradeState,
  TemplateSchema,
  TemplateInfoField,
} from '../types/grading';
import { computeScore, applyCorrection, TEMPLATE_VARIANT_LABEL, VJU_PRESET_SCHEMA } from '../types/grading';

// ── Display model types ───────────────────────────────────────────────────────

export interface DisplayCell {
  value:       string;
  formula?:    string;    // formula string without leading '='
  colSpan?:    number;
  rowSpan?:    number;
  isSpanned?:  boolean;   // cell is covered by another cell's merge — skip rendering
  fillColor?:  string;    // '#RRGGBB' or undefined
  fontColor?:  string;    // '#RRGGBB' or undefined
  fontBold?:   boolean;
  fontSize?:   number;
  fontItalic?: boolean;
  hAlign?:     'left' | 'center' | 'right';
  wrapText?:   boolean;
  hasBorder?:  boolean;
}

export interface DisplayRow {
  height: number;   // pixels
  cells:  DisplayCell[];
}

export interface DisplaySheet {
  name:       string;
  colWidths:  number[];   // pixel widths, one per data column
  colLetters: string[];
  rows:       DisplayRow[];
  frozenRow?: number;     // rows 1..frozenRow are sticky headers
  colCount:   number;
  rowCount:   number;
}

export interface WorkbookDisplay {
  sheets: DisplaySheet[];
}

// ── Builder options ───────────────────────────────────────────────────────────

export interface BuildWorkbookOptions {
  batch:            BatchGradeState;
  results:          OmrGradeResult[];
  answerKey:        AnswerKeyStore | null;
  corrections:      CorrectionsStore;
  dataSource?:      string;
  examName?:        string | null;
  includeReview?:   boolean;
  includeAnswers?:  boolean;
  highlightReview?: boolean;
  templateSchema?:  TemplateSchema | null;
}

// ── Colours ───────────────────────────────────────────────────────────────────

const C = {
  red:       'C8102E',
  redDark:   '9B0C22',
  white:     'FFFFFF',
  dark:      '1F2937',
  muted:     '6B7280',
  rowAlt:    'F9FAFB',
  border:    'D1D5DB',
  footerBg:  '374151',
  footerTxt: 'FFFFFF',
  warnBg:    'FEF3C7',
  warnTxt:   '92400E',
  okBg:      'D1FAE5',
  okTxt:     '065F46',
  errBg:     'FEE2E2',
  metaBg:    'FFF9F9',
} as const;

// ── Low-level ExcelJS helpers ─────────────────────────────────────────────────

type Cell = ExcelJS.Cell;
type Row  = ExcelJS.Row;

function fill(cell: Cell, argb: string) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + argb } };
}

function fnt(cell: Cell, opts: { bold?: boolean; color?: string; size?: number; italic?: boolean }) {
  cell.font = {
    name: 'Calibri', bold: opts.bold ?? false, italic: opts.italic ?? false,
    size: opts.size ?? 11,
    color: opts.color ? { argb: 'FF' + opts.color } : undefined,
  };
}

function bdr(cell: Cell, color = C.border) {
  const s: ExcelJS.BorderStyle = 'thin';
  const c = { style: s, color: { argb: 'FF' + color } };
  cell.border = { top: c, bottom: c, left: c, right: c };
}

function aln(cell: Cell, h: ExcelJS.Alignment['horizontal'] = 'left', wrap = false) {
  cell.alignment = { horizontal: h, vertical: 'middle', wrapText: wrap };
}

function txt(cell: Cell, value: string | null | undefined) {
  const s = value == null || value === '' ? '—' : String(value);
  cell.value = { richText: [{ text: s, font: { name: 'Calibri', size: 11 } }] };
}

function dash(v: unknown): string {
  return (v == null || v === '') ? '—' : String(v);
}

function styleVjuHeader(row: Row, numCols: number) {
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    fill(cell, C.red); fnt(cell, { bold: true, color: C.white, size: 11 });
    aln(cell, 'center'); bdr(cell);
  }
  row.height = 30;
}

function styleDataRow(row: Row, numCols: number, isAlt: boolean) {
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    if (isAlt) fill(cell, C.rowAlt);
    aln(cell, 'left'); bdr(cell);
  }
  row.height = 22;
}

function styleFooter(row: Row, numCols: number) {
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    fill(cell, C.footerBg); fnt(cell, { bold: true, color: C.footerTxt, size: 11 });
    aln(cell, 'center'); bdr(cell, 'FFFFFF');
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
  if (warns.some(w => w.type === 'multi_mark_info_field')) p.push('Thông tin không chắc');
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

export function collectAnswerKeys(results: OmrGradeResult[], schema?: TemplateSchema | null): string[] {
  const seen = new Set<string>();
  for (const r of results) for (const k of Object.keys(r.answers ?? {})) seen.add(k);
  const schemaLabels = (schema ?? VJU_PRESET_SCHEMA).answerSections.flatMap(s => s.labels);
  const sorted: string[] = [];
  for (const k of schemaLabels) { if (seen.has(k)) { sorted.push(k); seen.delete(k); } }
  for (const k of [...seen].sort()) sorted.push(k);
  return sorted;
}

function infoColWidth(field: TemplateInfoField): number {
  const name = field.displayName.toLowerCase();
  if (name.includes('cccd') || name.includes('cmnd')) return 20;
  if (name.includes('sbd')  || name.includes('số báo')) return 14;
  return 12;
}

function templateLabel(batch: BatchGradeState): string {
  return batch.templateMode === 'custom'
    ? (batch.customTemplateName ? `Custom: ${batch.customTemplateName}` : 'Custom template')
    : (TEMPLATE_VARIANT_LABEL[batch.templateVariant] ?? batch.templateVariant);
}

// ── Sheet builders ────────────────────────────────────────────────────────────

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

  const scored = results.map(r => {
    const c = corrections[r.input?.filename ?? ''];
    const m = applyCorrection(r, c);
    return answerKey ? computeScore(m.answers ?? {}, answerKey) : null;
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  const total   = results.length;
  const withSc  = scored.length;
  const revCnt  = results.filter(needsReview).length;
  const corrCnt = Object.keys(corrections).length;
  const okCnt   = total - revCnt;
  const avg     = withSc ? Math.round(scored.reduce((a, b) => a + b.total, 0) / withSc * 100) / 100 : null;
  const hi      = withSc ? Math.max(...scored.map(s => s.total)) : null;
  const lo      = withSc ? Math.min(...scored.map(s => s.total)) : null;

  ws.mergeCells('A4:B4');
  const ih = ws.getRow(4).getCell(1);
  ih.value = 'THÔNG TIN ĐỢT CHẤM';
  fill(ih, C.red); fnt(ih, { bold: true, color: C.white, size: 11 }); aln(ih, 'left');
  ws.getRow(4).height = 26;

  const info: [string, string | number][] = [
    ['Template',         templateLabel(batch)],
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
  ws.mergeCells('A10:B10');
  const sh = ws.getRow(10).getCell(1);
  sh.value = 'CHỈ SỐ KẾT QUẢ';
  fill(sh, C.red); fnt(sh, { bold: true, color: C.white, size: 11 }); aln(sh, 'left');
  ws.getRow(10).height = 26;

  const stats: [string, string | number, string][] = [
    ['Tổng phiếu',            total,            C.white],
    ['Phiếu có điểm',         withSc,           C.white],
    ['Đã chấm (không lỗi)',   okCnt,            C.okBg],
    ['Cần kiểm tra',          revCnt,           C.warnBg],
    ['Đã sửa tay',            corrCnt,          C.okBg],
    ['Điểm trung bình',       avg  ?? '—',      C.white],
    ['Điểm cao nhất',         hi   ?? '—',      C.white],
    ['Điểm thấp nhất',        lo   ?? '—',      C.white],
  ];
  stats.forEach(([lbl, val, bg], i) => {
    const row = ws.getRow(11 + i);
    row.getCell(1).value = lbl; row.getCell(2).value = val;
    fnt(row.getCell(1), { bold: false, color: C.dark });
    fnt(row.getCell(2), { bold: true, color: C.dark, size: 12 });
    if (i % 2 && bg === C.white) fill(row.getCell(1), C.rowAlt);
    if (bg !== C.white) { fill(row.getCell(1), bg); fill(row.getCell(2), bg); }
    aln(row.getCell(2), 'center');
    bdr(row.getCell(1)); bdr(row.getCell(2));
    row.height = 22;
  });

  ws.getRow(19).height = 10;
  ws.mergeCells('A20:H20');
  const note = ws.getRow(20).getCell(1);
  note.value = '⚠  Các phiếu có trạng thái "Cần kiểm tra" nên được review trước khi sử dụng kết quả chính thức.';
  fill(note, C.warnBg);
  fnt(note, { italic: true, color: C.warnTxt, size: 11 });
  note.alignment = { wrapText: true, vertical: 'middle' };
  ws.getRow(20).height = 34;
}

function buildBangDiem(
  wb: ExcelJS.Workbook,
  batch: BatchGradeState,
  results: OmrGradeResult[],
  answerKey: AnswerKeyStore | null,
  corrections: CorrectionsStore,
  dataSource: string,
  highlightReview: boolean,
  infoFields: TemplateInfoField[],
) {
  const ws = wb.addWorksheet('Bảng điểm');

  const HEADERS = [
    'STT', 'File',
    ...infoFields.map(f => f.displayName),
    'Đúng', 'Sai', 'Trống', 'Điểm', 'Trạng thái', 'Cần xem lại',
  ];
  const NCOLS    = HEADERS.length;
  const MERGE_END = colIndexToLetter(Math.min(NCOLS, 26));

  ws.columns = [
    { width: 6  },
    { width: 28 },
    ...infoFields.map(f => ({ width: infoColWidth(f) })),
    { width: 8  }, { width: 8  }, { width: 8  },
    { width: 10 }, { width: 16 }, { width: 14 },
  ];

  // Title block
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

  // Metadata block
  const meta: [string, string][] = [
    ['Mẫu phiếu',      templateLabel(batch)],
    ['Thời gian chấm', new Date(batch.gradedAt).toLocaleString('vi-VN', { hour12: false })],
    ['Thời gian xuất', new Date().toLocaleString('vi-VN', { hour12: false })],
    ['Nguồn dữ liệu',  dataSource],
  ];
  const halfN  = Math.ceil(NCOLS / 2);
  const midCol = colIndexToLetter(halfN);
  const endCol = MERGE_END;

  meta.forEach(([lbl, val], i) => {
    const r = 3 + i;
    if (i < 2) {
      ws.mergeCells(`A${r}:${midCol}${r}`);
      const cell = ws.getCell(`A${r}`);
      cell.value = `${lbl}: ${val}`;
      fill(cell, C.metaBg); fnt(cell, { color: C.dark, size: 11 }); bdr(cell);
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      const row3or4 = r - 2 + 3;
      ws.mergeCells(`${colIndexToLetter(halfN + 1)}${row3or4}:${endCol}${row3or4}`);
      const cell2 = ws.getCell(`${colIndexToLetter(halfN + 1)}${row3or4}`);
      cell2.value = `${lbl}: ${val}`;
      fill(cell2, C.metaBg); fnt(cell2, { color: C.dark, size: 11 }); bdr(cell2);
      cell2.alignment = { vertical: 'middle', horizontal: 'left' };
    }
    ws.getRow(r).height = 22;
  });
  ws.getRow(5).height = 8;

  // Table header (frozen)
  const TABLE_START = 6;
  ws.views = [{ state: 'frozen', ySplit: TABLE_START }];
  const hRow = ws.getRow(TABLE_START);
  hRow.values = HEADERS;
  styleVjuHeader(hRow, NCOLS);
  ws.autoFilter = { from: { row: TABLE_START, column: 1 }, to: { row: TABLE_START, column: NCOLS } };

  // Data rows
  results.forEach((r, i) => {
    const fname  = r.input?.filename ?? '';
    const corr   = corrections[fname];
    const merged = applyCorrection(r, corr);
    const sc     = answerKey ? computeScore(merged.answers ?? {}, answerKey) : null;
    const info   = merged.student_info ?? r.student_info ?? {};
    const isCorrected = !!corr;
    const review = needsReview(r);
    const isAlt  = i % 2 === 1;

    const row = ws.getRow(TABLE_START + 1 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = dash(fname);
    infoFields.forEach((field, fi) => { txt(row.getCell(3 + fi), info[field.key] ?? null); });

    const sc0 = 3 + infoFields.length;
    row.getCell(sc0).value     = sc ? sc.correct : '—';
    row.getCell(sc0 + 1).value = sc ? sc.wrong   : '—';
    row.getCell(sc0 + 2).value = sc ? sc.blank   : '—';
    row.getCell(sc0 + 3).value = sc ? sc.total   : '—';
    row.getCell(sc0 + 4).value = statusLabel(r, isCorrected);
    row.getCell(sc0 + 5).value = review ? 'Có' : 'Không';

    styleDataRow(row, NCOLS, isAlt);
    aln(row.getCell(sc0 + 3), 'center');
    fnt(row.getCell(sc0 + 3), { bold: true, color: C.dark });
    row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };

    if (highlightReview && review) {
      fill(row.getCell(sc0 + 5), C.warnBg);
      fnt(row.getCell(sc0 + 5), { bold: true, color: C.warnTxt });
    }
    if (isCorrected) {
      fill(row.getCell(sc0 + 4), C.okBg);
      fnt(row.getCell(sc0 + 4), { color: C.okTxt });
    }
    if (r._error) for (let c = 1; c <= NCOLS; c++) fill(row.getCell(c), C.errBg);
    row.height = 22;
  });

  // Summary footer
  const scored = results.map(r => {
    const c = corrections[r.input?.filename ?? ''];
    const m = applyCorrection(r, c);
    return answerKey ? computeScore(m.answers ?? {}, answerKey) : null;
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  const total  = results.length;
  const revCnt = results.filter(needsReview).length;
  const avg    = scored.length ? Math.round(scored.reduce((a, b) => a + b.total, 0) / scored.length * 100) / 100 : null;
  const hi     = scored.length ? Math.max(...scored.map(s => s.total)) : null;
  const lo     = scored.length ? Math.min(...scored.map(s => s.total)) : null;
  const pct    = total > 0 ? Math.round(revCnt / total * 1000) / 10 : 0;

  const footerData: [string, string | number][] = [
    ['THỐNG KÊ TỔNG',        ''],
    ['Tổng phiếu',            total],
    ['Điểm trung bình',       avg  ?? '—'],
    ['Cao nhất',              hi   ?? '—'],
    ['Thấp nhất',             lo   ?? '—'],
    ['Cần kiểm tra',          revCnt],
    ['Tỷ lệ cần kiểm tra',   `${pct}%`],
  ];
  const footerStart = TABLE_START + 1 + results.length + 1;
  ws.getRow(footerStart - 1).height = 8;

  footerData.forEach(([lbl, val], i) => {
    const row = ws.getRow(footerStart + i);
    if (i === 0) {
      ws.mergeCells(`A${footerStart}:${MERGE_END}${footerStart}`);
      const cell = row.getCell(1);
      cell.value = 'THỐNG KÊ TỔNG';
      fill(cell, C.footerBg); fnt(cell, { bold: true, color: C.footerTxt, size: 12 });
      aln(cell, 'center'); row.height = 28; return;
    }
    row.getCell(1).value = lbl; row.getCell(2).value = val;
    styleFooter(row, 2);
    fnt(row.getCell(1), { bold: false, color: C.footerTxt, size: 11 });
    fnt(row.getCell(2), { bold: true, color: C.footerTxt, size: 12 });
    aln(row.getCell(2), 'center'); row.height = 24;
  });
}

function buildCanKiemTra(
  wb: ExcelJS.Workbook,
  results: OmrGradeResult[],
  answerKey: AnswerKeyStore | null,
  corrections: CorrectionsStore,
  infoFields: TemplateInfoField[],
) {
  const ws = wb.addWorksheet('Cần kiểm tra');
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const shownInfo = infoFields.slice(0, 3);
  const headers = ['STT', 'File', ...shownInfo.map(f => f.displayName), 'Điểm', 'Lý do', 'Chi tiết cảnh báo', 'Gợi ý'];
  ws.columns = [
    { width: 6  }, { width: 28 },
    ...shownInfo.map(f => ({ width: infoColWidth(f) })),
    { width: 9 }, { width: 30 }, { width: 52 }, { width: 52 },
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
    ws.getRow(2).height = 28; return;
  }

  reviewRows.forEach((r, i) => {
    const fname  = r.input?.filename ?? '';
    const corr   = corrections[fname];
    const merged = applyCorrection(r, corr);
    const sc     = answerKey ? computeScore(merged.answers ?? {}, answerKey) : null;
    const info   = merged.student_info ?? r.student_info ?? {};

    const row = ws.getRow(2 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = dash(fname);
    shownInfo.forEach((field, fi) => { txt(row.getCell(3 + fi), info[field.key] ?? null); });
    const sc2 = 3 + shownInfo.length;
    row.getCell(sc2).value     = sc ? sc.total : '—';
    row.getCell(sc2 + 1).value = lyrDo(r);
    row.getCell(sc2 + 2).value = chiTietCanhBao(r);
    row.getCell(sc2 + 3).value = 'Mở màn hình Kiểm tra lỗi để đối chiếu ảnh gốc và ảnh detect trước khi sử dụng kết quả chính thức.';

    styleDataRow(row, headers.length, i % 2 === 1);
    aln(row.getCell(sc2), 'center'); fnt(row.getCell(sc2), { bold: true, color: C.dark });
    fill(row.getCell(sc2 + 1), C.warnBg); fnt(row.getCell(sc2 + 1), { color: C.warnTxt });
    row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
    row.getCell(sc2 + 2).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(sc2 + 3).alignment = { wrapText: true, vertical: 'top' };
    fnt(row.getCell(sc2 + 3), { italic: true, color: C.muted });
    row.height = 44;
  });
}

function buildChiTietDapAn(
  wb: ExcelJS.Workbook,
  results: OmrGradeResult[],
  corrections: CorrectionsStore,
  answerCols: string[],
  infoFields: TemplateInfoField[],
) {
  const ws = wb.addWorksheet('Chi tiết đáp án');
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  if (answerCols.length === 0) {
    // No MCQ fields — informational row
    ws.mergeCells('A1:D1');
    const cell = ws.getRow(1).getCell(1);
    cell.value = 'Template này không có phần đáp án.';
    fill(cell, C.warnBg); fnt(cell, { italic: true, color: C.warnTxt, size: 11 });
    cell.alignment = { vertical: 'middle', wrapText: true };
    ws.getRow(1).height = 28;
    return;
  }

  const shownInfo = infoFields.slice(0, 2);
  const fixed   = ['STT', 'File', ...shownInfo.map(f => f.displayName)];
  const headers = [...fixed, ...answerCols.map((_, i) => `Câu ${i + 1}`)];
  ws.columns = [
    { width: 6  }, { width: 28 },
    ...shownInfo.map(f => ({ width: infoColWidth(f) })),
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
    shownInfo.forEach((field, fi) => { txt(row.getCell(3 + fi), info[field.key] ?? null); });
    const ansBase = 3 + shownInfo.length;
    answerCols.forEach((key, ci) => {
      const v = answers[key];
      row.getCell(ansBase + ci).value = (v == null || v === '') ? '—' : String(v);
    });

    styleDataRow(row, headers.length, i % 2 === 1);
    row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
    for (let ci = 0; ci < answerCols.length; ci++) aln(row.getCell(ansBase + ci), 'center');
    row.height = 22;
  });
}

// ── Public builder ────────────────────────────────────────────────────────────

export function buildResultsWorkbook(opts: BuildWorkbookOptions): ExcelJS.Workbook {
  const {
    batch, results, answerKey, corrections,
    dataSource      = 'Không rõ',
    includeReview   = true,
    includeAnswers  = true,
    highlightReview = true,
    templateSchema,
  } = opts;

  const schema     = templateSchema ?? batch.templateSchema ?? VJU_PRESET_SCHEMA;
  const infoFields = schema.infoFields;
  const answerCols = collectAnswerKeys(results, schema);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'VJU Smart Grading';
  wb.created = wb.modified = new Date();

  buildTongQuan(wb, batch, results, answerKey, corrections, dataSource);
  buildBangDiem(wb, batch, results, answerKey, corrections, dataSource, highlightReview, infoFields);
  if (includeReview)  buildCanKiemTra(wb, results, answerKey, corrections, infoFields);
  if (includeAnswers) buildChiTietDapAn(wb, results, corrections, answerCols, infoFields);

  return wb;
}

// ── Display model extraction ──────────────────────────────────────────────────

function colIndexToLetter(n: number): string {
  let result = '';
  let idx = n;
  while (idx > 0) {
    idx--;
    result = String.fromCharCode(65 + (idx % 26)) + result;
    idx = Math.floor(idx / 26);
  }
  return result;
}

function argbToHex(argb: string | undefined): string | undefined {
  if (!argb) return undefined;
  const s = argb.replace('#', '');
  if (s.length === 8) return `#${s.slice(2)}`;
  if (s.length === 6) return `#${s}`;
  return undefined;
}

function getCellDisplayValue(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    // RichText
    if (Array.isArray((v as Record<string, unknown>)['richText'])) {
      return ((v as { richText: { text?: string }[] }).richText)
        .map(r => r.text ?? '').join('');
    }
    // Formula
    if (typeof (v as Record<string, unknown>)['formula'] === 'string') {
      const result = (v as { result?: unknown }).result;
      return result !== undefined && result !== null ? String(result) : '';
    }
    // Hyperlink
    if (typeof (v as Record<string, unknown>)['text'] === 'string') {
      return (v as { text: string }).text;
    }
    // Error
    if (typeof (v as Record<string, unknown>)['error'] !== 'undefined') return '#ERR';
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toLocaleDateString('vi-VN');
  return String(v);
}

function getCellFormula(cell: ExcelJS.Cell): string | undefined {
  const v = cell.value;
  if (v && typeof v === 'object') {
    const formula = (v as Record<string, unknown>)['formula'];
    if (typeof formula === 'string') return formula;
  }
  return undefined;
}

function getFillColor(cell: ExcelJS.Cell): string | undefined {
  const f = cell.fill as ExcelJS.FillPattern | undefined;
  if (!f || f.type !== 'pattern' || f.pattern === 'none' || !f.fgColor) return undefined;
  return argbToHex(f.fgColor.argb);
}

function getFontColor(cell: ExcelJS.Cell): string | undefined {
  return argbToHex(cell.font?.color?.argb);
}

/**
 * Extract a WorkbookDisplay from an ExcelJS workbook so it can be rendered as HTML.
 * Reads merged cell spans from ExcelJS internals (stable across ExcelJS 4.x).
 */
export function buildWorkbookDisplay(wb: ExcelJS.Workbook): WorkbookDisplay {
  const sheets: DisplaySheet[] = [];

  wb.eachSheet(ws => {
    const rowCount = Math.max(ws.rowCount ?? 0, (ws as any).actualRowCount ?? 0);
    const colCount = Math.max(ws.columnCount ?? 0, (ws as any).actualColumnCount ?? 0);

    if (rowCount === 0 || colCount === 0) {
      sheets.push({ name: ws.name, colWidths: [], colLetters: [], rows: [], colCount: 0, rowCount: 0 });
      return;
    }

    // Read merge spans from ExcelJS 4.x internal _merges object
    // Format: { [tl_address]: { model: { top, left, bottom, right, sheetName } } }
    const masterSpans = new Map<string, { rs: number; cs: number }>();
    const spannedKeys = new Set<string>();

    try {
      const mergesObj = (ws as any)._merges as Record<string, { model: { top: number; left: number; bottom: number; right: number } }> | undefined;
      if (mergesObj && typeof mergesObj === 'object') {
        for (const merge of Object.values(mergesObj)) {
          const m = merge?.model;
          if (!m || typeof m.top !== 'number') continue;
          const { top, left, bottom, right } = m;
          masterSpans.set(`${top}:${left}`, { rs: bottom - top + 1, cs: right - left + 1 });
          for (let r = top; r <= bottom; r++) {
            for (let c = left; c <= right; c++) {
              if (r !== top || c !== left) spannedKeys.add(`${r}:${c}`);
            }
          }
        }
      }
    } catch {
      // _merges not accessible — merges won't render, but cells will still show
    }

    // Column widths and letters
    const colWidths:  number[] = [];
    const colLetters: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      const col = ws.getColumn(c);
      // ExcelJS width is in "character widths" (~7-8 px each at 11pt Calibri)
      colWidths.push(Math.round((col.width ?? 10) * 7.5));
      colLetters.push(colIndexToLetter(c));
    }

    // Frozen row from worksheet views
    let frozenRow: number | undefined;
    for (const view of (ws.views ?? [])) {
      if ('ySplit' in view && typeof (view as any).ySplit === 'number') {
        frozenRow = (view as any).ySplit as number;
      }
    }

    // Rows
    const rows: DisplayRow[] = [];
    for (let r = 1; r <= rowCount; r++) {
      const wsRow = ws.getRow(r);
      const cells: DisplayCell[] = [];

      for (let c = 1; c <= colCount; c++) {
        const key = `${r}:${c}`;
        if (spannedKeys.has(key)) {
          cells.push({ value: '', isSpanned: true });
          continue;
        }
        const cell = wsRow.getCell(c);
        const span = masterSpans.get(key);
        cells.push({
          value:      getCellDisplayValue(cell),
          formula:    getCellFormula(cell),
          colSpan:    span?.cs,
          rowSpan:    span?.rs,
          fillColor:  getFillColor(cell),
          fontColor:  getFontColor(cell),
          fontBold:   cell.font?.bold ?? false,
          fontSize:   cell.font?.size,
          fontItalic: cell.font?.italic ?? false,
          hAlign:     cell.alignment?.horizontal as 'left' | 'center' | 'right' | undefined,
          wrapText:   cell.alignment?.wrapText ?? false,
          hasBorder:  !!(cell.border?.top || cell.border?.bottom || cell.border?.left || cell.border?.right),
        });
      }

      rows.push({ height: wsRow.height ?? 20, cells });
    }

    sheets.push({ name: ws.name, colWidths, colLetters, rows, frozenRow, colCount, rowCount });
  });

  return { sheets };
}
