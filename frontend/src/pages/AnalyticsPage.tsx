/**
 * AnalyticsPage.tsx
 * =================
 * Thống kê & Phân tích — VJU Smart Grading
 *
 * Data: the phiếu saved on the server (GET /results), filtered by kỳ thi and
 * lượt chấm, each scored like the Kết quả page (its own mẫu phiếu, the đáp án
 * of its own mã đề, thang 10) — see utils/analyticsLive.ts. No made-up numbers.
 *
 * Sections:
 *  A. Header + Kỳ thi / Lượt chấm filters
 *  B. 4 KPI cards (điểm TB compared with the lượt chấm before)
 *  C. Score distribution (BarChart) + Classification donut (PieChart)
 *  D. Trend by lượt chấm + comparison by mã đề
 *  E. Hardest questions table
 */

import { useState, useMemo, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
  LineChart, Line, ResponsiveContainer,
} from 'recharts';
import { BarChart3, TrendingUp, Users, Percent, AlertCircle, Loader2 } from 'lucide-react';

import { loadAnswerKey, type OmrGradeResult, type TemplateSchema } from '../types/grading';
import { resultsApi, examsApi, customFormsApi } from '../services/apiClient';
import type { ExamOut } from '../types/exam';
import { dbRowToOmrResult } from '../utils/resultMapping';
import { buildSchemaFromDetail, buildTemplateOptionsFromRows, getRowTemplateKey } from '../utils/templateSchema';
import { serverDate } from '../utils/serverDate';
import { computeDistribution, computeClassification } from '../utils/analytics';
import type { HardQuestion } from '../utils/analytics';
import { scoreRows, scoresOf, kpiOf, hardQuestionsOf, byLot, byMaDe } from '../utils/analyticsLive';

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

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Loader2 size={32} className="text-gray-300 mb-4 animate-spin" />
      <p className="text-sm text-gray-400">Đang tải dữ liệu…</p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

/** "07/10 00:57" */
function lotTime(iso: string): string {
  const d = serverDate(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const selectCls = 'px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 shadow-sm max-w-full';

export default function AnalyticsPage() {
  // ── Load data: every phiếu saved on the server + the kỳ thi names ─────────
  const [rows, setRows]       = useState<{ r: OmrGradeResult; examId: number | null }[]>([]);
  const [exams, setExams]     = useState<ExamOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [schemas, setSchemas] = useState<Map<number, TemplateSchema>>(new Map());

  useEffect(() => {
    let cancelled = false;
    examsApi.list().then(e => { if (!cancelled) setExams(e); }).catch(() => {});
    resultsApi.list({ limit: 1000 })
      .then(resp => {
        if (cancelled) return;
        setRows(resp.items.map(it => ({ r: dbRowToOmrResult(it), examId: it.exam_id ?? null })));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // custom mẫu phiếu: their fields (where SBD / mã đề / câu are)
  useEffect(() => {
    const ids = [...new Set(rows.map(x => x.r).filter(r => r.template_type === 'custom' && r.template_id != null)
      .map(r => r.template_id as number))].filter(id => !schemas.has(id));
    if (!ids.length) return;
    Promise.all(ids.map(id => customFormsApi.get(id).then(d => [id, buildSchemaFromDetail(d)] as const).catch(() => null)))
      .then(got => setSchemas(prev => {
        const next = new Map(prev);
        for (const g of got) if (g) next.set(g[0], g[1]);
        return next;
      }));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const answerKey = useMemo(() => loadAnswerKey(), []);

  // ── Filters: kỳ thi, then lượt chấm (default: the latest one) ─────────────
  const [examFilter, setExamFilter] = useState<string>('all');   // 'all' | 'none' | exam id
  const [lotFilter, setLotFilter]   = useState<string>('latest'); // 'latest' | 'all' | graded_at

  const examRows = useMemo(() => rows.filter(x =>
    examFilter === 'all' ? true : examFilter === 'none' ? x.examId == null : String(x.examId) === examFilter,
  ), [rows, examFilter]);

  const lots = useMemo(() => {
    const m = new Map<string, OmrGradeResult[]>();
    for (const { r } of examRows) if (r.graded_at) m.set(r.graded_at, [...(m.get(r.graded_at) ?? []), r]);
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
      .map(([iso, rs]) => ({
        iso, count: rs.length,
        source: rs.every(r => r.input?.filename?.startsWith('cham-nhanh_')) ? 'Chấm nhanh' : 'Tải ảnh lên',
      }));
  }, [examRows]);
  const lotIso = lotFilter === 'latest' ? (lots[0]?.iso ?? null) : lotFilter === 'all' ? null : lotFilter;

  const schemaOf = useMemo(() => {
    const opts = buildTemplateOptionsFromRows(rows.map(x => x.r), null, schemas);
    return (r: OmrGradeResult): TemplateSchema =>
      opts.find(o => o.key === getRowTemplateKey(r, null))?.templateSchema ?? { infoFields: [], answerSections: [] };
  }, [rows, schemas]);

  const scoredExam = useMemo(() => scoreRows(examRows, answerKey, schemaOf), [examRows, answerKey, schemaOf]);
  const shown = useMemo(() => lotIso ? scoredExam.filter(x => x.gradedAt === lotIso) : scoredExam, [scoredExam, lotIso]);
  const hasData = shown.length > 0;

  const scores         = useMemo(() => scoresOf(shown), [shown]);
  const kpi            = useMemo(() => kpiOf(shown), [shown]);
  const distribution   = useMemo(() => computeDistribution(scores), [scores]);
  const classification = useMemo(() => {
    const slices = computeClassification(scores);
    return slices.length > 0 ? slices : [{ name: 'Chưa có điểm', value: 1, color: '#E0E0E0' }];
  }, [scores]);
  const hardQuestions: HardQuestion[] = useMemo(() => hardQuestionsOf(shown).slice(0, 5), [shown]);
  const trend          = useMemo(() => byLot(scoredExam, lotTime), [scoredExam]);
  const maDeStats      = useMemo(() => byMaDe(shown), [shown]);

  // điểm TB compared with the lượt chấm just before the one shown
  const vsPrev = useMemo(() => {
    if (!lotIso || kpi.avgScore == null) return null;
    const i = trend.findIndex(p => p.key === lotIso);
    const prev = i > 0 ? trend[i - 1] : null;
    if (!prev || prev.avgScore == null) return null;
    return { diff: Math.round((kpi.avgScore - prev.avgScore) * 100) / 100, label: prev.label };
  }, [lotIso, kpi.avgScore, trend]);

  const noKey = hasData && scores.length === 0;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* ── A. Header + filters ── */}
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <BarChart3 size={24} style={{ color: VJU_RED }} />
              Thống kê &amp; Phân tích
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Điểm thang 10, tính giống trang Kết quả — theo kỳ thi và lượt chấm bạn chọn
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 min-w-0">
            <label className="flex flex-col gap-1 min-w-0">
              <span className="text-xs font-semibold text-gray-500">Kỳ thi</span>
              <select className={selectCls} value={examFilter}
                onChange={e => { setExamFilter(e.target.value); setLotFilter('latest'); }}>
                <option value="all">Tất cả kỳ thi</option>
                <option value="none">Không gắn kỳ thi</option>
                {exams.map(ex => <option key={ex.id} value={String(ex.id)}>{ex.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 min-w-0">
              <span className="text-xs font-semibold text-gray-500">Lượt chấm</span>
              <select className={selectCls} value={lotFilter} onChange={e => setLotFilter(e.target.value)}>
                <option value="latest">Lượt mới nhất{lots[0] ? ` (${lotTime(lots[0].iso)})` : ''}</option>
                <option value="all">Tất cả lượt chấm ({examRows.length} phiếu)</option>
                {lots.map(l => <option key={l.iso} value={l.iso}>{lotTime(l.iso)} · {l.source} · {l.count} phiếu</option>)}
              </select>
            </label>
          </div>
        </div>

        {loading && <LoadingState />}
        {!loading && !hasData && <EmptyState />}

        {!loading && hasData && (
        <>
        {noKey && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Chưa tính được điểm: các phiếu này chưa có đáp án cho mã đề của chúng. Vào trang Đáp án (hoặc chọn bộ đáp án ở Chấm nhanh) cho đúng mẫu phiếu và mã đề.
          </div>
        )}

        {/* ── B. KPI Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <KpiCard
            icon={<TrendingUp size={18} />}
            title="Điểm TB"
            value={kpi.avgScore !== null ? kpi.avgScore.toFixed(2) : '—'}
            sub={vsPrev
              ? `${vsPrev.diff >= 0 ? '↑' : '↓'} ${Math.abs(vsPrev.diff).toFixed(2)} so với lượt ${vsPrev.label}`
              : 'thang 10'}
            subColor={vsPrev ? (vsPrev.diff >= 0 ? 'text-emerald-500' : 'text-red-400') : 'text-gray-400'}
          />
          <KpiCard
            icon={<Users size={18} />}
            title="Số bài"
            value={kpi.totalStudents.toLocaleString('vi-VN')}
            sub={scores.length < kpi.totalStudents ? `${scores.length} bài có điểm` : 'bài đã chấm'}
          />
          <KpiCard
            icon={<Percent size={18} />}
            title="Tỉ lệ đạt"
            value={kpi.passRate !== null ? `${kpi.passRate.toFixed(1)}%` : '—'}
            sub="điểm ≥ 5.0"
          />
          <KpiCard
            icon={<AlertCircle size={18} />}
            title="Câu khó"
            value={kpi.hardQuestionsCount !== null ? String(kpi.hardQuestionsCount) : '—'}
            sub="tỉ lệ sai > 55%"
            subColor="text-red-400"
          />
        </div>

        {/* ── C. Distribution + Classification ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <AnalyticsCard title="Phân phối điểm" desc="Số bài theo khoảng điểm (thang 10)" className="lg:col-span-2">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={distribution} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                <XAxis dataKey="range" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: '#FEF2F2' }} />
                <Bar dataKey="count" name="Số bài" radius={[4, 4, 0, 0]}>
                  {distribution.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </AnalyticsCard>

          <AnalyticsCard title="Xếp loại" desc="Theo thang điểm 10">
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie data={classification} cx="50%" cy="50%" innerRadius={45} outerRadius={72} paddingAngle={2} dataKey="value">
                  {classification.map((c, i) => <Cell key={i} fill={c.color} />)}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <ClassLegend data={classification} />
          </AnalyticsCard>
        </div>

        {/* ── D. Trend by lượt chấm + by mã đề ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <AnalyticsCard title="Xu hướng theo lượt chấm"
            desc={`Điểm TB (thang 10) và tỉ lệ đạt của từng lượt${examFilter === 'all' ? '' : ' trong kỳ thi đã chọn'}`}>
            {trend.length < 2 ? (
              <p className="text-sm text-gray-400 py-10 text-center">Cần ít nhất 2 lượt chấm để xem xu hướng.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={trend} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9CA3AF' }} />
                  <YAxis yAxisId="d" domain={[0, 10]} tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                  <YAxis yAxisId="p" orientation="right" domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: '#6B7280', paddingTop: 8 }} />
                  <Line yAxisId="d" type="monotone" dataKey="avgScore" name="Điểm TB" stroke={VJU_RED} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line yAxisId="p" type="monotone" dataKey="passRate" name="Tỉ lệ đạt (%)" stroke="#E85A6A" strokeDasharray="4 3" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            )}
          </AnalyticsCard>

          <AnalyticsCard title="So sánh theo mã đề" desc="Điểm TB (thang 10) và tỉ lệ đạt của từng mã đề">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={maDeStats} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                <XAxis dataKey="maDe" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <YAxis yAxisId="d" domain={[0, 10]} tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <YAxis yAxisId="p" orientation="right" domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: '#FEF2F2' }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: '#6B7280', paddingTop: 8 }} />
                <Bar yAxisId="d" dataKey="avgScore" name="Điểm TB" fill={VJU_RED} radius={[3, 3, 0, 0]} barSize={14} />
                <Bar yAxisId="p" dataKey="passRate" name="Tỉ lệ đạt (%)" fill="#F4A4B0" radius={[3, 3, 0, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </AnalyticsCard>
        </div>

        {/* ── E. Hard questions table ── */}
        <AnalyticsCard title="Top câu hỏi khó nhất" desc="Các câu có tỉ lệ sai/bỏ trống cao nhất">
          {hardQuestions.length === 0 ? (
            <EmptyState />
          ) : (
            <div>
              {hardQuestions.map((q, i) => <HardQuestionRow key={q.questionId} rank={i + 1} q={q} />)}
            </div>
          )}
        </AnalyticsCard>
        </>
        )}

      </div>
    </div>
  );
}
