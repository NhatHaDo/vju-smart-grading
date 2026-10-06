/**
 * exportResultsExcel.ts — thin wrapper: build workbook → write .xlsx
 *
 * The workbook is built by buildResultsWorkbook() in excelWorkbookBuilder.ts,
 * which is the single source of truth for both preview and export.
 */

import { saveAs } from 'file-saver';
import type {
  BatchGradeState,
  OmrGradeResult,
  AnswerKeyStore,
  CorrectionsStore,
  TemplateSchema,
} from '../types/grading';
import { buildResultsWorkbook } from './excelWorkbookBuilder';

export interface ExportOptions {
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

/** The results workbook as a file (name + bytes), without saving it —
 *  "Tải tất cả" puts it in a .zip next to the graded pictures. */
export async function buildResultsExcelFile(opts: ExportOptions): Promise<File> {
  const wb = buildResultsWorkbook(opts);
  const now = new Date();
  const p   = (n: number) => String(n).padStart(2, '0');
  const ts  = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
  const examName = opts.examName ?? opts.batch.examName ?? null;
  const examSlug = examName
    ? '_' + examName.replace(/[^a-zA-Z0-9À-ỹ]/g, '_').replace(/_+/g, '_').slice(0, 30)
    : '';
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], `BangDiem${examSlug}_${ts}.xlsx`,
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export async function exportResultsExcel(opts: ExportOptions): Promise<void> {
  if (!opts.results || opts.results.length === 0) {
    alert('Chưa có kết quả để xuất Excel.');
    return;
  }
  const file = await buildResultsExcelFile(opts);
  saveAs(file, file.name);
}
