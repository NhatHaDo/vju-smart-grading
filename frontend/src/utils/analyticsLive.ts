/**
 * analyticsLive.ts — the numbers on Thống kê & Phân tích (2026-10-07)
 *
 * "cái thống kê và phân tích nnay t thấy cứ kiểu gì ? nó đang chiếu dữ liệu
 * của cái gì ?": the page mixed every phiếu on the server, read the mã đề the
 * Mẫu VJU way (so a Phiếu Bộ GD's mã đề was never found → no answer key → no
 * điểm), and filled the gaps with numbers written in the code ("↑ 0.4 so với
 * kỳ trước", "T1 → T6", "Toán / PTBV / Vật lý…"). Now every number comes from
 * the phiếu shown, scored exactly like the Kết quả page does: each phiếu with
 * its own mẫu phiếu's fields and the đáp án of its own mã đề.
 */
import {
  computeScore, getMaDeValue, resolveAnswerKeyForMaDe, answersMatch,
  type AnswerKeySet, type AnswerKeyStore, type OmrGradeResult, type TemplateSchema,
} from '../types/grading';
import type { HardQuestion, KpiData } from './analytics';

export interface ScoredRow {
  r:        OmrGradeResult;
  examId:   number | null;
  gradedAt: string | null;
  maDe:     string | null;
  key:      AnswerKeySet | AnswerKeyStore | null;
  schema:   TemplateSchema;
  /** thang 10 (see computeScore); null = no đáp án for this phiếu's mã đề */
  score:    number | null;
}

const hasAnswers = (k: AnswerKeySet | AnswerKeyStore | null): k is AnswerKeySet | AnswerKeyStore =>
  !!k && Object.values(k.answers ?? {}).some(Boolean);

export function scoreRows(
  rows: { r: OmrGradeResult; examId: number | null }[],
  answerKey: AnswerKeyStore | null,
  schemaOf: (r: OmrGradeResult) => TemplateSchema,
): ScoredRow[] {
  return rows.filter(({ r }) => !r._error).map(({ r, examId }) => {
    const schema = schemaOf(r);
    const maDe = getMaDeValue(r.student_info, schema);
    const { key } = answerKey ? resolveAnswerKeyForMaDe(answerKey, maDe) : { key: null };
    const k = hasAnswers(key) ? key : null;
    return {
      r, examId, schema, maDe, key: k,
      gradedAt: r.graded_at ?? null,
      score: k ? computeScore(r.answers ?? {}, k).total : null,
    };
  });
}

const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 100) / 100 : null;
const passPct = (xs: number[]) => xs.length ? Math.round(xs.filter(s => s >= 5).length / xs.length * 1000) / 10 : null;
export const scoresOf = (rows: ScoredRow[]) => rows.map(x => x.score).filter((s): s is number => s !== null);

/** Câu with the most wrong/blank answers among the phiếu (each against its own đáp án). */
export function hardQuestionsOf(rows: ScoredRow[]): HardQuestion[] {
  const tally = new Map<string, { right: number; total: number; name: string; section: string }>();
  for (const x of rows) {
    if (!x.key) continue;
    const order = x.schema.answerSections.flatMap(s => s.labels);
    for (const [q, expected] of Object.entries(x.key.answers)) {
      if (!expected) continue;
      const idx = order.indexOf(q);
      const section = x.schema.answerSections.find(s => s.labels.includes(q))?.name ?? '';
      const t = tally.get(q) ?? { right: 0, total: 0, name: idx >= 0 ? `Câu ${idx + 1}` : q, section };
      const got = x.r.answers?.[q] ?? null;
      t.total++;
      if (got && answersMatch(got, expected)) t.right++;
      tally.set(q, t);
    }
  }
  return [...tally.entries()]
    .map(([q, t]) => {
      const wrongRate = Math.round((1 - t.right / t.total) * 1000) / 10;
      return { questionId: q, displayName: t.name, subject: t.section, wrongRate, rightRate: Math.round((100 - wrongRate) * 10) / 10 };
    })
    .sort((a, b) => b.wrongRate - a.wrongRate);
}

export function kpiOf(rows: ScoredRow[]): KpiData {
  const s = scoresOf(rows);
  const hq = hardQuestionsOf(rows);
  return {
    avgScore: avg(s),
    totalStudents: rows.length,
    passRate: passPct(s),
    hardQuestionsCount: hq.length ? hq.filter(q => q.wrongRate > 55).length : null,
  };
}

export interface LotPoint { key: string; label: string; avgScore: number | null; passRate: number | null; count: number }

/** One point per lượt chấm (oldest first): its điểm TB and tỉ lệ ≥ 5. */
export function byLot(rows: ScoredRow[], label: (iso: string) => string): LotPoint[] {
  const groups = new Map<string, ScoredRow[]>();
  for (const x of rows) {
    if (!x.gradedAt) continue;
    groups.set(x.gradedAt, [...(groups.get(x.gradedAt) ?? []), x]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([iso, xs]) => ({ key: iso, label: label(iso), avgScore: avg(scoresOf(xs)), passRate: passPct(scoresOf(xs)), count: xs.length }));
}

export interface MaDePoint { maDe: string; avgScore: number | null; passRate: number | null; count: number }

/** One bar group per mã đề: its điểm TB and tỉ lệ ≥ 5. */
export function byMaDe(rows: ScoredRow[]): MaDePoint[] {
  const groups = new Map<string, ScoredRow[]>();
  for (const x of rows) {
    const k = x.maDe ?? 'Không rõ';
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([maDe, xs]) => ({ maDe, avgScore: avg(scoresOf(xs)), passRate: passPct(scoresOf(xs)), count: xs.length }));
}
