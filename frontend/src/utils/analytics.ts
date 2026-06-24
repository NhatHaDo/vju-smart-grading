/**
 * analytics.ts
 * ============
 * Pure helper functions for the Analytics page.
 * All functions are data-in / value-out with no side-effects.
 * Swap mock data for real data by replacing the fallback branches.
 */

import type { BatchGradeState, OmrGradeResult, AnswerKeyStore } from '../types/grading';
import { computeScore, SECTION_MAP } from '../types/grading';

// ── localStorage loaders ──────────────────────────────────────────────────────

export const BATCH_LS_KEY = 'vju_last_batch_grade';

export function loadBatchFromStorage(): BatchGradeState | null {
  try {
    const raw = localStorage.getItem(BATCH_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BatchGradeState;
    if (!parsed || !Array.isArray(parsed.results)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Score computation ─────────────────────────────────────────────────────────

/**
 * Derive a 0-10 score for a single result.
 * If answerKey is present we use computeScore + max questions → percentage * 10.
 * If no key, returns null (caller can use mock/display N/A).
 */
export function deriveScore(
  result: OmrGradeResult,
  answerKey: AnswerKeyStore | null,
): number | null {
  if (!answerKey) return null;
  const keyed = Object.keys(answerKey.answers);
  if (keyed.length === 0) return null;
  const sc = computeScore(result.answers ?? {}, answerKey);
  // Use raw correct count / total questions → 0-10
  const pct = sc.correct / keyed.length;
  return Math.round(pct * 10 * 100) / 100;
}

/** Return array of numeric scores (0-10) for all results that have a score. */
export function allScores(
  results: OmrGradeResult[],
  answerKey: AnswerKeyStore | null,
): number[] {
  return results
    .map(r => deriveScore(r, answerKey))
    .filter((s): s is number => s !== null);
}

// ── KPI helpers ───────────────────────────────────────────────────────────────

export interface KpiData {
  avgScore: number | null;
  totalStudents: number;
  passRate: number | null;          // 0-100 %
  hardQuestionsCount: number | null; // câu có tỉ lệ sai > 55%
}

export function computeKpi(
  results: OmrGradeResult[],
  answerKey: AnswerKeyStore | null,
): KpiData {
  const total = results.filter(r => !r._error).length;
  const scores = allScores(results, answerKey);

  const avgScore =
    scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null;

  const passCount = scores.filter(s => s >= 5).length;
  const passRate = scores.length > 0 ? Math.round((passCount / scores.length) * 1000) / 10 : null;

  const hardQ = computeHardQuestions(results, answerKey);
  const hardQuestionsCount = hardQ !== null ? hardQ.filter(q => q.wrongRate > 55).length : null;

  return { avgScore, totalStudents: total, passRate, hardQuestionsCount };
}

// ── Distribution ──────────────────────────────────────────────────────────────

export interface ScoreBucket {
  range: string;
  count: number;
  fill: string;   // color
}

const VJU_RED       = '#C8102E';
const VJU_RED_LIGHT = '#F4A4B0';

const BUCKETS: { range: string; lo: number; hi: number; highlight: boolean }[] = [
  { range: '0–2',  lo: 0,   hi: 2,   highlight: false },
  { range: '2–4',  lo: 2,   hi: 4,   highlight: false },
  { range: '4–5',  lo: 4,   hi: 5,   highlight: false },
  { range: '5–6',  lo: 5,   hi: 6,   highlight: false },
  { range: '6–7',  lo: 6,   hi: 7,   highlight: false },
  { range: '7–8',  lo: 7,   hi: 8,   highlight: true  },
  { range: '8–9',  lo: 8,   hi: 9,   highlight: true  },
  { range: '9–10', lo: 9,   hi: 10.01, highlight: false },
];

export function computeDistribution(scores: number[]): ScoreBucket[] {
  return BUCKETS.map(b => ({
    range:  b.range,
    count:  scores.filter(s => s >= b.lo && s < b.hi).length,
    fill:   b.highlight ? VJU_RED : VJU_RED_LIGHT,
  }));
}

// ── Classification (xếp loại) ─────────────────────────────────────────────────

export interface ClassificationSlice {
  name:  string;
  value: number;
  color: string;
}

const CLASSIFICATIONS: { name: string; min: number; color: string }[] = [
  { name: 'Xuất sắc', min: 9,   color: '#8B1A2F' },
  { name: 'Giỏi',     min: 8,   color: '#C8102E' },
  { name: 'Khá',      min: 6.5, color: '#E85A6A' },
  { name: 'Trung bình', min: 5, color: '#F4A4B0' },
  { name: 'Yếu',      min: 0,   color: '#E0E0E0' },
];

export function computeClassification(scores: number[]): ClassificationSlice[] {
  return CLASSIFICATIONS.map(c => {
    const next = CLASSIFICATIONS.find(x => x.min > c.min);
    const count = next
      ? scores.filter(s => s >= c.min && s < next.min).length
      : scores.filter(s => s >= c.min).length;
    return { name: c.name, value: count, color: c.color };
  }).filter(s => s.value > 0);
}

// ── Trend (xu hướng) — mock data ─────────────────────────────────────────────

export interface TrendPoint {
  month: string;
  avgScore: number;
  passRate: number;
}

/**
 * For now uses mock data.
 * Replace with real backend time-series data when available.
 */
export function getTrendData(): TrendPoint[] {
  return [
    { month: 'T1', avgScore: 6.5,  passRate: 72 },
    { month: 'T2', avgScore: 6.8,  passRate: 75 },
    { month: 'T3', avgScore: 7.0,  passRate: 78 },
    { month: 'T4', avgScore: 6.9,  passRate: 77 },
    { month: 'T5', avgScore: 7.2,  passRate: 81 },
    { month: 'T6', avgScore: 7.24, passRate: 83 },
  ];
}

// ── Subject comparison ─────────────────────────────────────────────────────────

export interface SubjectStat {
  subject: string;
  avgScore: number;
  passRate: number;
}

/**
 * Compute per-section averages from real results + answerKey.
 * Falls back to mock data if insufficient info.
 */
export function computeSubjectStats(
  results: OmrGradeResult[],
  answerKey: AnswerKeyStore | null,
): SubjectStat[] {
  // Attempt real computation
  if (answerKey && results.length > 0) {
    const sections = Object.entries(SECTION_MAP);
    const stats: SubjectStat[] = [];
    for (const [sectionName, questionIds] of sections) {
      const totalQ = questionIds.length;
      if (totalQ === 0) continue;
      const sectionScores = results
        .filter(r => !r._error)
        .map(r => {
          const ans = r.answers ?? {};
          const correct = questionIds.filter(qId => {
            const student = ans[qId];
            const expected = answerKey.answers[qId];
            return student && expected && student === expected;
          }).length;
          return (correct / totalQ) * 10;
        });
      if (sectionScores.length === 0) continue;
      const avg = sectionScores.reduce((a, b) => a + b, 0) / sectionScores.length;
      const pass = sectionScores.filter(s => s >= 5).length / sectionScores.length * 100;
      // Shorten section name for chart label
      const label = sectionName.replace(' (Bắt buộc)', '');
      stats.push({ subject: label, avgScore: Math.round(avg * 100) / 100, passRate: Math.round(pass * 10) / 10 });
    }
    if (stats.length > 0) return stats;
  }

  // Mock fallback
  return [
    { subject: 'Toán',    avgScore: 6.8,  passRate: 74 },
    { subject: 'PTBV',    avgScore: 7.4,  passRate: 85 },
    { subject: 'Vật lý',  avgScore: 6.2,  passRate: 65 },
    { subject: 'Hóa học', avgScore: 6.5,  passRate: 68 },
    { subject: 'Sinh học',avgScore: 7.1,  passRate: 79 },
    { subject: 'CNNN',    avgScore: 6.9,  passRate: 77 },
  ];
}

// ── Hard questions ─────────────────────────────────────────────────────────────

export interface HardQuestion {
  questionId: string;
  displayName: string;
  subject: string;
  wrongRate: number;   // 0-100 %
  rightRate: number;   // 0-100 %
}

/**
 * Find questions with highest wrong rate across all results.
 * Returns null if answerKey is missing (use mock).
 */
export function computeHardQuestions(
  results: OmrGradeResult[],
  answerKey: AnswerKeyStore | null,
): HardQuestion[] | null {
  if (!answerKey || results.length === 0) return null;

  const validResults = results.filter(r => !r._error);
  if (validResults.length === 0) return null;

  // Build reverse map: questionId → section name
  const qToSection: Record<string, string> = {};
  for (const [section, ids] of Object.entries(SECTION_MAP)) {
    for (const id of ids) {
      qToSection[id] = section.replace(' (Bắt buộc)', '');
    }
  }

  const questionIds = Object.keys(answerKey.answers);
  const stats: HardQuestion[] = questionIds.map(qId => {
    const correctAns = answerKey.answers[qId];
    let correct = 0, wrong = 0, blank = 0;
    for (const r of validResults) {
      const student = (r.answers ?? {})[qId] ?? null;
      if (!student)              blank++;
      else if (student === correctAns) correct++;
      else                       wrong++;
    }
    const total = validResults.length;
    const wrongRate = Math.round(((wrong + blank) / total) * 1000) / 10;
    const rightRate = 100 - wrongRate;

    // Human-readable display name
    const num = qId.replace(/^[a-z]+/i, '');
    const displayName = `Câu ${num || qId}`;

    return {
      questionId: qId,
      displayName,
      subject: qToSection[qId] ?? 'Khác',
      wrongRate,
      rightRate,
    };
  });

  return stats.sort((a, b) => b.wrongRate - a.wrongRate);
}

// ── Mock data fallbacks ───────────────────────────────────────────────────────

export const MOCK_SCORES: number[] = [
  3.5, 4.0, 4.5, 5.0, 5.0, 5.5, 5.5, 6.0, 6.0, 6.0,
  6.5, 6.5, 6.5, 7.0, 7.0, 7.0, 7.0, 7.5, 7.5, 7.5,
  7.5, 8.0, 8.0, 8.0, 8.5, 8.5, 9.0, 9.0, 9.5, 10.0,
];

export const MOCK_KPI: KpiData = {
  avgScore: 7.24,
  totalStudents: 30,
  passRate: 83.3,
  hardQuestionsCount: 3,
};

export const MOCK_HARD_QUESTIONS: HardQuestion[] = [
  { questionId: 'toan13', displayName: 'Câu 13', subject: 'Toán',    wrongRate: 72, rightRate: 28 },
  { questionId: 'vl7',    displayName: 'Câu 7',  subject: 'Vật lý',  wrongRate: 65, rightRate: 35 },
  { questionId: 'hh9',    displayName: 'Câu 9',  subject: 'Hóa học', wrongRate: 61, rightRate: 39 },
  { questionId: 'toan5',  displayName: 'Câu 5',  subject: 'Toán',    wrongRate: 58, rightRate: 42 },
  { questionId: 'vl3',    displayName: 'Câu 3',  subject: 'Vật lý',  wrongRate: 56, rightRate: 44 },
];
