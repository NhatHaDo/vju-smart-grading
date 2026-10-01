/**
 * pickedAnswersExcel.ts — the "file đáp án" of a đề (2026-10-01).
 *
 * "ko có add file đáp án à ? (với lại có thêm file mẫu để điền đáp án nữa)",
 * "tại sao cái này file đáp án trống trơn v":
 *   - answerTemplate(): an Excel listing EVERY trắc nghiệm of the chosen
 *     file (# | Câu trong file | Nội dung | Đáp án | Ghi chú), the answers
 *     the file marks or picked on the page already filled in, the Đáp án
 *     cell a dropdown of that câu's real letters.
 *   - readAnswerFile(): reads it back (.xlsx), a .csv / .txt key, or the VJU
 *     answer key (Answer Key page's Excel), into {n-th trắc nghiệm: option}.
 *     "#" = the n-th trắc nghiệm of the file, so re-sorting rows is fine.
 */
import ExcelJS from 'exceljs';
import type { UnansweredQuestion } from '../services/apiClient';
import { parseAnswerText } from '../components/common/UnansweredPicker';
import { plainText } from '../components/common/RichText';

const LETTERS = 'ABCDEFGH';
const HEAD = ['#', 'Câu trong file', 'Nội dung câu hỏi', 'Đáp án', 'Ghi chú'];

export async function answerTemplate(all: UnansweredQuestion[], picked: Record<number, number>): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Đáp án', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ width: 7 }, { width: 16 }, { width: 80 }, { width: 10 }, { width: 26 }];
  const head = ws.addRow(HEAD);
  head.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8102E' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (const u of all) {
    const letters = LETTERS.slice(0, u.options.length);
    const inFile = u.answer >= 0;
    const ans = inFile ? u.answer : picked[u.i];
    const row = ws.addRow([u.mcq_no, u.number || u.where, plainText(u.content) || '(công thức / hình ảnh)',
      ans != null ? LETTERS[ans] : '', inFile ? 'Đáp án có trong file đề' : '']);
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(5).font = { italic: true, color: { argb: 'FF6B7280' } };
    const cell = row.getCell(4);
    cell.alignment = { horizontal: 'center' };
    cell.font = { bold: true, color: { argb: 'FFC8102E' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: inFile ? 'FFF3F4F6' : 'FFFFFBEB' } };
    cell.dataValidation = {
      type: 'list', allowBlank: true, formulae: [`"${letters.split('').join(',')}"`],
      showErrorMessage: true, errorTitle: 'Đáp án', error: `Chọn một trong ${letters.split('').join(', ')}`,
    };
  }

  const help = wb.addWorksheet('Hướng dẫn');
  help.getColumn(1).width = 110;
  [
    'Mỗi dòng là một câu trắc nghiệm của file đề, cột "#" là thứ tự câu trắc nghiệm trong file (1 = câu đầu tiên).',
    'Điền cột "Đáp án" (chọn A, B, C, D trong ô, hoặc gõ chữ cái). Ô để trống = chưa có đáp án.',
    'Dòng ghi "Đáp án có trong file đề" (nền xám): đáp án lấy từ file Word (tô đỏ, gạch chân hoặc dòng Đáp án), chỉ để xem.',
    'Không sửa cột "#". Lưu file rồi bấm "Nhập đáp án nhanh" → "Nạp file đáp án" trên trang.',
  ].forEach(t => help.addRow([t]));

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** What an answer file gives: {n-th trắc nghiệm of the đề (1-based): option}
 *  — "#" of our template / a .csv, "1A 2C…" or "ACBD…" of a text key, or
 *  "Phần I-II, câu n" of a VJU answer key (Answer Key page's Excel). */
export interface AnswerFile {
  byMcq: Map<number, number>;
  note?: string;
}

export async function readAnswerFile(file: File): Promise<AnswerFile> {
  if (/\.xlsx$/i.test(file.name)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const sheets = wb.worksheets.map(ws => {
      const rows: string[][] = [];
      ws.eachRow({ includeEmpty: true }, r => { rows.push((r.values as unknown[]).slice(1).map(v => cellText(v))); });
      return { name: ws.name, rows };
    });
    // a VJU answer key: per mã đề sheets ("Đề 101"…) or one "Đáp án" sheet
    const vju = sheets.map(sh => ({ sh, map: fromVjuKey(sh.rows) })).filter(x => x.map && x.map.size > 0);
    if (vju.length > 0) {
      return { byMcq: vju[0].map!, note: 'File đáp án mẫu VJU: Phần I-II câu n = câu trắc nghiệm thứ n của đề.'
        + (vju.length > 1 ? ` File có ${vju.length} sheet đáp án, dùng sheet "${vju[0].sh.name}".` : '') };
    }
    const main = sheets.find(sh => sh.name === 'Đáp án') ?? sheets[0];
    const rows = main?.rows ?? [];
    return { byMcq: fromRows(rows) ?? parseAnswerText(rows.map(r => r.join(' ')).join('\n')) };
  }
  const text = await file.text();
  const rows = text.split(/\r?\n/).map(l => l.split(/[,;\t]/).map(s => s.trim().replace(/^"|"$/g, '')));
  return { byMcq: fromRows(rows) ?? parseAnswerText(text) };
}

const norm = (s: string) => s.normalize('NFC').toLowerCase().trim();

/** VJU answer key rows (header "Phần" | "Câu" | "Đáp án") → {n-th trắc nghiệm: option}.
 *  A Phần is trắc nghiệm when its filled answers are all single letters
 *  (not Đ/S); its rows, blanks included, count 1, 2, 3… in order. */
function fromVjuKey(rows: string[][]): Map<number, number> | null {
  const h = rows.findIndex(r => r.some(c => norm(c) === 'phần') && r.some(c => norm(c) === 'câu')
    && r.some(c => norm(c).startsWith('đáp án')));
  if (h < 0) return null;
  const iPart = rows[h].findIndex(c => norm(c) === 'phần');
  const iAns = rows[h].findIndex(c => norm(c).startsWith('đáp án'));
  const parts: { name: string; answers: string[] }[] = [];
  for (const r of rows.slice(h + 1)) {
    const name = (r[iPart] || '').trim();
    if (!name) continue;
    if (parts.length === 0 || parts[parts.length - 1].name !== name) parts.push({ name, answers: [] });
    parts[parts.length - 1].answers.push((r[iAns] || '').trim().toUpperCase());
  }
  const out = new Map<number, number>();
  let n = 0;
  for (const p of parts) {
    const filled = p.answers.filter(a => a && a !== '—');
    const isMcq = filled.length > 0 && filled.every(a => a.length === 1 && LETTERS.includes(a));   // Đ/S, số: not
    if (!isMcq) continue;
    for (const a of p.answers) {
      n++;
      if (a.length === 1 && LETTERS.includes(a)) out.set(n, LETTERS.indexOf(a));
    }
  }
  return out;
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && v && 'richText' in v) return (v as { richText: { text: string }[] }).richText.map(t => t.text).join('');
  if (typeof v === 'object' && v && 'result' in v) return String((v as { result: unknown }).result ?? '');
  return String(v).trim();
}

/** A table with a "#" column and an "Đáp án" column, else null. */
function fromRows(rows: string[][]): Map<number, number> | null {
  const h = rows.findIndex(r => r.some(c => norm(c) === '#') && r.some(c => norm(c).startsWith('đáp án')));
  if (h < 0) return null;
  const iNum = rows[h].findIndex(c => norm(c) === '#');
  const iAns = rows[h].findIndex(c => norm(c).startsWith('đáp án'));
  const out = new Map<number, number>();
  for (const r of rows.slice(h + 1)) {
    const n = Number(r[iNum]);
    const a = (r[iAns] || '').trim().toUpperCase();
    if (Number.isInteger(n) && n > 0 && a.length === 1 && LETTERS.includes(a)) out.set(n, LETTERS.indexOf(a));
  }
  return out;
}
