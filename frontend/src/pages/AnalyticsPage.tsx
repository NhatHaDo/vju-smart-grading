/**
 * AnalyticsPage.tsx
 * =================
 * Thống kê & Phân tích — VJU Smart Grading
 *
 * Data priority:
 *  1. localStorage `vju_last_batch_grade` + `vju_answer_key`
 *  2. Mock data fallback (UI always renders)
 *
 * Sections:
 *  A. Header + exam filter dropdown
 *  B. 4 KPI cards
 *  C. Score distribution (BarChart) + Classification donut (PieChart)
 *  D. Trend AreaChart + Subject grouped BarChart
 *  E. Hardest questions table
 */

import { useState, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
  AreaChart, Area, ResponsiveContainer,
} from 'recharts';
import { BarChart3, TrendingUp, Users, Percent, AlertCircle, ChevronDown } from 'lucide-react';

import { loadAnswerKey } from '../types/grading';
import {
  loadBatchFromStorage,
  allScores,
  computeKpi,
  computeDistribution,
  computeClassification,
  computeSubjectStats,
  computeHardQuestions,
  getTrendData,
  MOCK_SCORES,
  MOCK_KPI,
  MOCK_HARD_QUESTIONS,
} from '../utils/analytics';
import type { KpiData, HardQuestion } from '../utils/analytics';

// ── Constants ─────────────────────────────────────────────────────────────────

const VJU_RED = '#C8102E';

// ── Shared Tooltip ────────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { color: string; name: string; value: number }[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-md px-3 py-2 text-xs">
      {label && <div className="font-semibold text-gray-600 mb-1">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-gray-700">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span>{p.name}:</span>
          <span className="font-semibold">{typeof p.value === 'number' ? p.value.toLocaleString('vi-VN', { maximumFractionDigits: 2 }) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────

function AnalyticsCard({ title, desc, children, className = '' }: {
  title?: string;
  desc?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-white rounded-2xl shadow-sm border border-gray-100 p-5 ${className}`}>
      {title && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
          {desc && <p className="text-xs text-gray-400 mt-0.5">{desc}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({ icon, title, value, sub, subColor = 'text-gray-400' }: {
  icon: React.ReactNode;
  title: string;
  value: string;
  sub?: string;
  subColor?: string;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: '#FEF2F2', color: VJU_RED }}>
          {icon}
        </div>
        <span className="text-xs text-gray-500 font-medium">{title}</span>
      </div>
      <div className="text-2xl font-bold text-gray-800">{value}</div>
      {sub && <div className={`text-xs mt-1 ${subColor}`}>{sub}</div>}
    </div>
  );
}

// ── Pie chart legend ──────────────────────────────────────────────────────────

function ClassLegend({ data }: { data: { name: string; value: number; color: string }[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-3">
      {data.map(d => (
        <div key={d.name} className="flex items-center gap-1.5 text-xs text-gray-600">
          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: d.color }} />
          {d.name} <span className="text-gray-400">({d.value})</span>
        </div>
      ))}
    </div>
  );
}

// ── Hard question row ─────────────────────────────────────────────────────────

function HardQuestionRow({ rank, q }: { rank: number; q: HardQuestion }) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-gray-50 last:border-0">
      <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 flex-shrink-0">
        {rank}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-gray-800">{q.displayName}</span>
          <span className="text-xs text-gray-400 ml-2 flex-shrink-0">{q.subject}</span>
        </div>
        <div className="relative h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${q.wrongRate}%`, background: VJU_RED }}
          />
        </div>
      </div>
      <div className="text-xs font-semibold text-gray-700 flex-shrink-0 w-14 text-right">
        {q.rightRate.toFixed(0)}% đúng
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <BarChart3 size={48} className="text-gray-200 mb-4" />
      <h3 className="text-base font-semibold text-gray-500">Chưa có dữ liệu chấm thi</h3>
      <p className="text-sm text-gray-400 mt-1">Vui lòng upload và chấm bài trước khi xem thống kê.</p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [examFilter, setExamFilter] = useState<string>('all');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // ── Load data ──────────────────────────────────────────────────────────────
  const batch     = useMemo(() => loadBatchFromStorage(), []);
  const answerKey = useMemo(() => loadAnswerKey(), []);

  const hasRealData = batch !== null && batch.results.length > 0;

  // Scores: real or mock
  const scores = useMemo(() => {
    if (!hasRealData) return MOCK_SCORES;
    const real = allScores(batch!.results, answerKey);
    return real.length > 0 ? real : MOCK_SCORES;
  }, [batch, answerKey, hasRealData]);

  const usingMockScores = !hasRealData || allScores(batch?.results ?? [], answerKey).length === 0;

  // KPI
  const kpi: KpiData = useMemo(() => {
    if (!hasRealData) return MOCK_KPI;
    const computed = computeKpi(batch!.results, answerKey);
    return {
      avgScore:            computed.avgScore            ?? MOCK_KPI.avgScore,
      totalStudents:       computed.totalStudents > 0   ? computed.totalStudents : MOCK_KPI.totalStudents,
      passRate:            computed.passRate             ?? MOCK_KPI.passRate,
      hardQuestionsCount:  computed.hardQuestionsCount  ?? MOCK_KPI.hardQuestionsCount,
    };
  }, [batch, answerKey, hasRealData]);

  // Distribution
  const distribution = useMemo(() => computeDistribution(scores), [scores]);

  // Classification
  const classification = useMemo(() => {
    const slices = computeClassification(scores);
    return slices.length > 0 ? slices : [{ name: 'Chưa có dữ liệu', value: 1, color: '#E0E0E0' }];
  }, [scores]);

  // Trend
  const trendData = useMemo(() => getTrendData(), []);

  // Subject stats
  const subjectStats = useMemo(
    () => computeSubjectStats(batch?.results ?? [], answerKey),
    [batch, answerKey],
  );

  // Hard questions
  const hardQuestions: HardQuestion[] = useMemo(() => {
    if (!hasRealData) return MOCK_HARD_QUESTIONS;
    const real = computeHardQuestions(batch!.results, answerKey);
    return real && real.length > 0 ? real.slice(0, 5) : MOCK_HARD_QUESTIONS;
  }, [batch, answerKey, hasRealData]);

  // Exam filter options from batch
  const examOptions = useMemo(() => {
    if (!hasRealData) return [];
    const variants = Array.from(new Set(
      batch!.results.map(r => r.student_info?.ma_de).filter(Boolean) as string[]
    ));
    return variants;
  }, [batch, hasRealData]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* ── A. Header ── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <BarChart3 size={24} style={{ color: VJU_RED }} />
              Thống kê &amp; Phân tích
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Tổng quan kết quả chấm thi, phân phối điểm và câu hỏi cần chú ý
              {usingMockScores && (
                <span className="ml-2 inline-flex items-center gap-1 text-amber-500">
                  <AlertCircle size={12} /> dữ liệu minh hoạ
                </span>
              )}
            </p>
          </div>

          {/* Exam filter dropdown */}
          <div className="relative">
            <button
              onClick={() => setDropdownOpen(v => !v)}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 shadow-sm hover:border-red-300 transition-colors"
            >
              {examFilter === 'all' ? 'Tất cả' : `Mã đề ${examFilter}`}
              <ChevronDown size={14} className={`transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {dropdownOpen && (
              <div className="absolute right-0 mt-1 w-40 bg-white border border-gray-100 rounded-xl shadow-lg z-50 py-1">
                <button
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => { setExamFilter('all'); setDropdownOpen(false); }}
                >
                  Tất cả
                </button>
                {examOptions.map(opt => (
                  <button
                    key={opt}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => { setExamFilter(opt); setDropdownOpen(false); }}
                  >
                    Mã đề {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Empty state when no data at all */}
        {!hasRealData && scores === MOCK_SCORES && false /* always show with mock */ && (
          <EmptyState />
        )}

        {/* ── B. KPI Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <KpiCard
            icon={<TrendingUp size={18} />}
            title="Điểm TB"
            value={kpi.avgScore !== null ? kpi.avgScore.toFixed(2) : '—'}
            sub="↑ 0.4 so với kỳ trước"
            subColor="text-emerald-500"
          />
          <KpiCard
            icon={<Users size={18} />}
            title="Tổng SV"
            value={kpi.totalStudents.toLocaleString('vi-VN')}
            sub="bài đã chấm"
          />
          <KpiCard
            icon={<Percent size={18} />}
            title="Tỉ lệ qua"
            value={kpi.passRate !== null ? `${kpi.passRate.toFixed(1)}%` : '—'}
            sub="điểm ≥ 5.0"
          />
          <KpiCard
            icon={<AlertCircle size={18} />}
            title="Câu lỗi"
            value={kpi.hardQuestionsCount !== null ? String(kpi.hardQuestionsCount) : '—'}
            sub="tỉ lệ sai > 55%"
            subColor="text-red-400"
          />
        </div>

        {/* ── C. Distribution + Classification ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          {/* Bar chart — distribution */}
          <AnalyticsCard
            title="Phân phối điểm"
            desc="Số lượng bài theo khoảng điểm"
            className="lg:col-span-2"
          >
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={distribution} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                <XAxis dataKey="range" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: '#FEF2F2' }} />
                <Bar dataKey="count" name="Số bài" radius={[4, 4, 0, 0]}>
                  {distribution.map((d, i) => (
                    <Cell key={i} fill={d.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </AnalyticsCard>

          {/* Donut — classification */}
          <AnalyticsCard title="Xếp loại" desc="Theo thang điểm 10">
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie
                  data={classification}
                  cx="50%"
                  cy="50%"
                  innerRadius={45}
                  outerRadius={72}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {classification.map((c, i) => (
                    <Cell key={i} fill={c.color} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <ClassLegend data={classification} />
          </AnalyticsCard>
        </div>

        {/* ── D. Trend + Subject comparison ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Area chart — trend */}
          <AnalyticsCard title="Xu hướng kết quả" desc="Theo tháng T1 → T6">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={trendData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradAvg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={VJU_RED} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={VJU_RED} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradPass" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#F4A4B0" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#F4A4B0" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 11, color: '#6B7280', paddingTop: 8 }}
                />
                <Area
                  type="monotone"
                  dataKey="avgScore"
                  name="Điểm TB"
                  stroke={VJU_RED}
                  strokeWidth={2}
                  fill="url(#gradAvg)"
                  dot={{ r: 3, fill: VJU_RED, strokeWidth: 0 }}
                />
                <Area
                  type="monotone"
                  dataKey="passRate"
                  name="Tỉ lệ qua (%)"
                  stroke="#E85A6A"
                  strokeWidth={2}
                  fill="url(#gradPass)"
                  dot={{ r: 3, fill: '#E85A6A', strokeWidth: 0 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </AnalyticsCard>

          {/* Grouped bar chart — subject comparison */}
          <AnalyticsCard title="So sánh theo môn" desc="Điểm TB và tỉ lệ qua (%)">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={subjectStats} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                <XAxis dataKey="subject" tick={{ fontSize: 10, fill: '#9CA3AF' }} />
                <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: '#FEF2F2' }} />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 11, color: '#6B7280', paddingTop: 8 }}
                />
                <Bar dataKey="avgScore" name="Điểm TB" fill={VJU_RED} radius={[3, 3, 0, 0]} barSize={12} />
                <Bar dataKey="passRate" name="Tỉ lệ qua (%)" fill="#F4A4B0" radius={[3, 3, 0, 0]} barSize={12} />
              </BarChart>
            </ResponsiveContainer>
          </AnalyticsCard>
        </div>

        {/* ── E. Hard questions table ── */}
        <AnalyticsCard
          title="Top câu hỏi khó nhất"
          desc="Các câu có tỉ lệ trả lời sai cao nhất"
        >
          {hardQuestions.length === 0 ? (
            <EmptyState />
          ) : (
            <div>
              {hardQuestions.map((q, i) => (
                <HardQuestionRow key={q.questionId} rank={i + 1} q={q} />
              ))}
            </div>
          )}
        </AnalyticsCard>

      </div>
    </div>
  );
}
