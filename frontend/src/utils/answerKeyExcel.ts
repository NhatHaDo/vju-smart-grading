/**
 * answerKeyExcel.ts — Excel import/export for Answer Key.
 *
 * Added 2026-07-29 per user request: teachers don't know how to work with
 * the JSON export/import ("import đáp án để excel đi, để json thầy cô sẽ
 * không biết dùng"), and the format must reflect each template's own real
 * sections/questions/mã đề — never a fixed layout — matching the Answer Key
 * editor screen and the actual answer sheet.
 *
 * Layout:
 *   - One sheet per mã đề when the answer key is split by mã đề
 *     ("Đề 101", "Đề 102", ...), else a single "Đáp án" sheet.
 *   - Each sheet: STT | Phần | Câu | Đáp án — one row per question, in the
 *     template's own section/label order. MCQ-type sections get an Excel
 *     dropdown (data validation) restricted to that section's real choices
 *     (A/B/C/D, or Đ/S for Đúng/Sai, etc.) so teachers can't type garbage.
 *     Composite/text sections (e.g. signed-decimal) get a free-text cell.
 *   - A "Thang điểm" sheet carries the scoring weights.
 *
 * Import re-reads the same shape, matching rows back to the CURRENT
 * template's schema by the technical "Câu" label (column C) — robust to
 * teachers re-sorting/reformatting rows, since matching isn't positional.
 */

import ExcelJS from 'exceljs';
import type { AnswerKeyStore, AnswerKeySet, ScoringWeights, TemplateSchema } from '../types/grading';
import { DEFAULT_SCORING } from '../types/grading';

const C = {
  red:     'C8102E',
  redDark: '9B0C22',
  white:   'FFFFFF',
  dark:    '1F2937',
  muted:   '6B7280',
  rowAlt:  'F9FAFB',
  border:  'D1D5DB',
};

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
function aln(cell: Cell, h: ExcelJS.Alignment['horizontal'] = 'left') {
  cell.alignment = { horizontal: h, vertical: 'middle' };
}
function styleHeader(row: Row, numCols: number) {
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    fill(cell, C.red); fnt(cell, { bold: true, color: C.white, size: 11 });
    aln(cell, 'center'); bdr(cell);
  }
  row.height = 24;
}

const HEADER_ROW = 4;
const COLS = { stt: 1, phan: 2, cau: 3, dapAn: 4 };

function buildAnswerSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  answers: Record<string, string>,
  schema: TemplateSchema,
  templateLabel: string,
): void {
  const ws = wb.addWorksheet(sheetName.slice(0, 31)); // Excel sheet-name length limit
  ws.columns = [{ width: 6 }, { width: 24 }, { width: 16 }, { width: 14 }];

  ws.mergeCells('A1:D1');
  const t1 = ws.getCell('A1');
  t1.value = 'VJU SMART GRADING — ĐÁP ÁN';
  fill(t1, C.red); fnt(t1, { bold: true, color: C.white, size: 14 }); aln(t1, 'center');
  ws.getRow(1).height = 32;

  ws.mergeCells('A2:D2');
  const t2 = ws.getCell('A2');
  t2.value = `Mẫu phiếu: ${templateLabel}`;
  fill(t2, C.redDark); fnt(t2, { italic: true, color: C.white, size: 11 }); aln(t2, 'center');
  ws.getRow(2).height = 22;
  ws.getRow(3).height = 8;

  const hRow = ws.getRow(HEADER_ROW);
  hRow.values = ['STT', 'Phần', 'Câu', 'Đáp án'];
  styleHeader(hRow, 4);
  ws.views = [{ state: 'frozen', ySplit: HEADER_ROW }];

  let stt = 1;
  let r = HEADER_ROW + 1;
  let sectionIdx = 0;
  for (const section of schema.answerSections) {
    const isText = section.inputType === 'text';
    const opts = section.options && section.options.length > 0 ? section.options : ['A', 'B', 'C', 'D'];
    for (const label of section.labels) {
      const row = ws.getRow(r);
      row.getCell(COLS.stt).value   = stt++;
      row.getCell(COLS.phan).value  = section.name;
      row.getCell(COLS.cau).value   = label;
      row.getCell(COLS.dapAn).value = answers[label] ?? '';
      for (let c = 1; c <= 4; c++) {
        const cell = row.getCell(c);
        bdr(cell);
        if (sectionIdx % 2 === 1) fill(cell, C.rowAlt);
      }
      aln(row.getCell(COLS.stt), 'center');
      fnt(row.getCell(COLS.cau), { color: C.muted });
      const dCell = row.getCell(COLS.dapAn);
      aln(dCell, 'center');
      fnt(dCell, { bold: true, color: C.dark });
      if (!isText) {
        dCell.dataValidation = {
          type: 'list', allowBlank: true,
          formulae: [`"${opts.join(',')}"`],
          showErrorMessage: true,
          errorStyle: 'warning',
          errorTitle: 'Đáp án không hợp lệ',
          error: `Chỉ chấp nhận: ${opts.join(', ')} (để trống nếu không chấm câu này)`,
        };
      }
      r++;
    }
    sectionIdx++;
  }

  if (schema.answerSections.length === 0) {
    ws.mergeCells(`A${HEADER_ROW + 1}:D${HEADER_ROW + 1}`);
    const cell = ws.getRow(HEADER_ROW + 1).getCell(1);
    cell.value = 'Mẫu phiếu này không có câu trắc nghiệm.';
    fnt(cell, { italic: true, color: C.muted }); aln(cell, 'center');
  }
}

function buildScoringSheet(wb: ExcelJS.Workbook, scoring: ScoringWeights): void {
  const ws = wb.addWorksheet('Thang điểm');
  ws.columns = [{ width: 22 }, { width: 12 }];
  const hRow = ws.getRow(1);
  hRow.values = ['Thang điểm', 'Giá trị'];
  styleHeader(hRow, 2);
  const rows: [string, number][] = [
    ['Đúng (+)',  scoring.correct],
    ['Sai (±)',   scoring.wrong],
    ['Bỏ trống',  scoring.blank],
  ];
  rows.forEach(([label, val], i) => {
    const row = ws.getRow(2 + i);
    row.getCell(1).value = label;
    row.getCell(2).value = val;
    bdr(row.getCell(1)); bdr(row.getCell(2));
    aln(row.getCell(2), 'center');
  });
}

/** Build the full Answer Key workbook — one sheet per mã đề (or a single
 *  flat sheet), plus a scoring sheet. */
export function buildAnswerKeyWorkbook(
  schema: TemplateSchema,
  store: AnswerKeyStore,
  templateLabel: string,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VJU Smart Grading';
  wb.created = wb.modified = new Date();

  const byMaDe = store.byMaDe && Object.keys(store.byMaDe).length > 0 ? store.byMaDe : null;
  if (byMaDe) {
    for (const [code, set] of Object.entries(byMaDe)) {
      buildAnswerSheet(wb, `Đề ${code}`, set.answers, schema, templateLabel);
    }
  } else {
    buildAnswerSheet(wb, 'Đáp án', store.answers, schema, templateLabel);
  }
  buildScoringSheet(wb, store.scoring);

  return wb;
}

/** Build a sample workbook filled with placeholder answers — same shape as
 *  buildAnswerKeyWorkbook, for teachers to use as a starting template. */
export function buildAnswerKeySampleWorkbook(schema: TemplateSchema, templateLabel: string): ExcelJS.Workbook {
  const sample: Record<string, string> = {};
  for (const section of schema.answerSections) {
    if (section.inputType === 'text') {
      section.labels.forEach(lbl => { sample[lbl] = '-12.34'; });
      continue;
    }
    const choices = section.options && section.options.length > 0 ? section.options : ['A', 'B', 'C', 'D'];
    section.labels.forEach((lbl, i) => { sample[lbl] = choices[i % choices.length]; });
  }
  const store: AnswerKeyStore = { answers: sample, scoring: DEFAULT_SCORING, updatedAt: new Date().toISOString() };
  return buildAnswerKeyWorkbook(schema, store, templateLabel);
}

export interface ParsedAnswerKeyResult {
  store:    AnswerKeyStore;
  warnings: string[];
}

function parseAnswerSheet(ws: ExcelJS.Worksheet, validLabels: Set<string>, warnings: string[]): Record<string, string> {
  // Locate the header row by scanning for "Câu" + "Đáp án" cells — not
  // assumed to be row HEADER_ROW so hand-edited files (extra rows inserted
  // above) still parse correctly.
  let headerRow = -1, colCau = -1, colDapAn = -1;
  const scanLimit = Math.min(15, ws.rowCount || 15);
  for (let r = 1; r <= scanLimit; r++) {
    const row = ws.getRow(r);
    let cCau = -1, cDapAn = -1;
    const lastCol = Math.max(row.cellCount, 6);
    for (let c = 1; c <= lastCol; c++) {
      const v = String(row.getCell(c).value ?? '').trim();
      if (v === 'Câu') cCau = c;
      if (v === 'Đáp án') cDapAn = c;
    }
    if (cCau > 0 && cDapAn > 0) { headerRow = r; colCau = cCau; colDapAn = cDapAn; break; }
  }
  if (headerRow === -1) {
    warnings.push(`Sheet "${ws.name}": không tìm thấy tiêu đề cột "Câu"/"Đáp án" — bỏ qua.`);
    return {};
  }

  const out: Record<string, string> = {};
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const label = String(row.getCell(colCau).value ?? '').trim();
    if (!label) continue;
    if (!validLabels.has(label)) {
      warnings.push(`Sheet "${ws.name}": không tìm thấy câu "${label}" trong mẫu phiếu hiện tại — bỏ qua dòng này.`);
      continue;
    }
    const raw = row.getCell(colDapAn).value;
    const val = raw == null ? '' : String(raw).trim();
    if (val && val !== '—') out[label] = val;
  }
  return out;
}

function parseScoringSheet(wb: ExcelJS.Workbook): ScoringWeights {
  const ws = wb.getWorksheet('Thang điểm');
  if (!ws) return { ...DEFAULT_SCORING };
  const map: Partial<ScoringWeights> = {};
  ws.eachRow(row => {
    const label = String(row.getCell(1).value ?? '').trim();
    const val = Number(row.getCell(2).value);
    if (Number.isNaN(val)) return;
    if (label.startsWith('Đúng')) map.correct = val;
    else if (label.startsWith('Sai')) map.wrong = val;
    else if (label.startsWith('Bỏ')) map.blank = val;
  });
  return {
    correct: map.correct ?? DEFAULT_SCORING.correct,
    wrong:   map.wrong   ?? DEFAULT_SCORING.wrong,
    blank:   map.blank   ?? DEFAULT_SCORING.blank,
  };
}

/** Parse an uploaded Answer Key .xlsx back into an AnswerKeyStore, matched
 *  against the CURRENT template's schema (so importing a file prepared for
 *  a different mẫu phiếu is caught, not silently misapplied). */
export async function parseAnswerKeyWorkbook(file: File, schema: TemplateSchema): Promise<ParsedAnswerKeyResult> {
  const buf = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  const validLabels = new Set(schema.answerSections.flatMap(s => s.labels));
  const warnings: string[] = [];
  const scoring = parseScoringSheet(wb);

  const maDeSheets: { code: string; ws: ExcelJS.Worksheet }[] = [];
  let flatSheet: ExcelJS.Worksheet | null = null;
  wb.eachSheet(ws => {
    if (ws.name === 'Thang điểm') return;
    const m = ws.name.match(/^Đề\s+(.+)$/);
    if (m) maDeSheets.push({ code: m[1].trim(), ws });
    else if (!flatSheet) flatSheet = ws;
  });

  const now = new Date().toISOString();

  if (maDeSheets.length > 0) {
    const byMaDe: Record<string, AnswerKeySet> = {};
    for (const { code, ws } of maDeSheets) {
      byMaDe[code] = { answers: parseAnswerSheet(ws, validLabels, warnings), scoring, updatedAt: now };
    }
    return { store: { answers: {}, scoring, updatedAt: now, byMaDe }, warnings };
  }
  if (flatSheet) {
    return { store: { answers: parseAnswerSheet(flatSheet, validLabels, warnings), scoring, updatedAt: now }, warnings };
  }
  return {
    store: { answers: {}, scoring, updatedAt: now },
    warnings: [...warnings, 'Không tìm thấy sheet đáp án hợp lệ trong file (thiếu cột "Câu"/"Đáp án").'],
  };
}
