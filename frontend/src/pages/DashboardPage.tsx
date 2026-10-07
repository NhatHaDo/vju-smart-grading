/**
 * DashboardPage.tsx — VJU Smart Grading
 *
 * All data comes from real DB endpoints:
 *   GET /api/v1/exams
 *   GET /api/v1/results?limit=500
 *
 * No mock data. Mock arrays that were here previously caused the
 * "18/90" progress and "-0.08" average bugs.
 */
import { useState, useEffect, useMemo } from 'react';
import { ClipboardList, ScanLine, AlertTriangle, TrendingUp, Calendar, Database, WifiOff, RefreshCw, ChevronDown, Pencil, BarChart3 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { StatCard } from '../components/common/Card';
import Card from '../components/common/Card';
import PageHeader from '../components/layout/PageHeader';
import Button from '../components/common/Button';
import Badge from '../components/common/Badge';
import { examsApi, resultsApi, customFormsApi, type BatchResultOut } from '../services/apiClient';
import { loadAnswerKey, type OmrGradeResult, type TemplateSchema } from '../types/grading';
import { dbRowToOmrResult } from '../utils/resultMapping';
import { buildSchemaFromDetail, buildTemplateOptionsFromRows, getRowTemplateKey } from '../utils/templateSchema';
import { scoreRows } from '../utils/analyticsLive';
import type { ExamOut } from '../types/exam';
import { semesterLabel, lecturerDisplay } from '../constants/examMeta';
import { useAuth } from '../app/providers';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read the expected student count from an exam object defensively.
 * The canonical backend field is `total_students`, but older cached
 * payloads or future API variants may use different names.
 * Returns a positive integer, or null if not available.
 */
function getExamStudentCount(exam: ExamOut): number | null {
  // Canonical field (current backend) — always try this first
  if (typeof exam.total_students === 'number' && exam.total_students > 0) {
    return exam.total_students;
  }
  // Defensive fallbacks for other possible field names that may appear
  // in cached/legacy API responses or future shape changes.
  const raw = exam as unknown as Record<string, unknown>;
  for (const key of ['student_count', 'studentCount', 'expected_students', 'students_count']) {
    const v = Number(raw[key]);
    if (Number.isInteger(v) && v > 0) return v;
  }
  return null;
}

/** A result needs human review if it has any warning signal. */
function resultNeedsReview(r: BatchResultOut): boolean {
  if (r.needs_review) return true;
  if (r.empty_count   > 0) return true;
  if (r.multi_mark_count > 0) return true;
  // check warnings_json has content
  if (r.warnings_json && r.warnings_json !== '[]' && r.warnings_json !== 'null') return true;
  return false;
}

/** Format YYYY-MM-DD → "DD/MM/YYYY" for display. */
function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  try {
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  } catch { return s; }
}

// ── Donut chart ──────────────────────────────────────────────────────────────

interface Slice { label: string; count: number; color: string }

function DonutChart({ data, centerLabel }: { data: Slice[]; centerLabel: string }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const R = 36; const C = 2 * Math.PI * R;
  let cum = 0;

  // If all zero: show a single grey ring
  const displayData: Slice[] = total === 0
    ? [{ label: 'Chưa có dữ liệu', count: 1, color: '#E5E7EB' }]
    : data.filter(d => d.count > 0);

  const displayTotal = total === 0 ? 1 : total;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <svg width={90} height={90} viewBox="0 0 90 90" style={{ flexShrink: 0 }}>
        {displayData.map((d, i) => {
          const pct    = d.count / displayTotal;
          const dash   = pct * C;
          const offset = C - cum * C;
          cum += pct;
          return (
            <circle key={i} cx={45} cy={45} r={R}
              fill="none" stroke={d.color} strokeWidth={14}
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={offset}
              transform="rotate(-90 45 45)"
            />
          );
        })}
        <text x={45} y={45} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill="#374151">
          {total}
        </text>
        <text x={45} y={57} textAnchor="middle" fontSize={8} fill="#9CA3AF">{centerLabel}</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data.map((d, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: d.color, flexShrink: 0 }} />
            <span style={{ color: '#374151' }}>{d.label}</span>
            <span style={{ marginLeft: 'auto', fontWeight: 700, color: '#1E1E1E', paddingLeft: 12 }}>{d.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SubjectBar ────────────────────────────────────────────────────────────────

const SUBJECT_COLORS = [
  '#C8102E', '#1B5E20', '#066AAB', '#FCB900',
  '#39B54A', '#8B5CF6', '#F59E0B', '#EC4899',
];

function SubjectBar({ label, avg, color, maxScore = 10 }: {
  label: string; avg: number | null; color: string; maxScore?: number;
}) {
  const display = avg !== null && avg >= 0 ? avg.toFixed(2) : '—';
  const pct     = avg !== null && avg >= 0 ? Math.min(100, (avg / maxScore) * 100) : 0;
  // 2026-10-07: a subject with nothing scored yet says so ("—" read as a
  // broken number); on a phone each subject is one row (globals.css)
  const has = avg !== null && avg >= 0;
  return (
    <div className="dash-subject-item" style={{ textAlign: 'center', background: '#F9FAFB', borderRadius: 10, padding: '14px 10px' }}>
      <div className={has ? 'dash-subject-value' : 'dash-subject-value dash-subject-none'} style={has
        ? { fontSize: 26, fontWeight: 800, color: '#1E1E1E' }
        : { fontSize: 13, fontWeight: 600, color: '#9CA3AF', minHeight: 31, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {has ? display : 'Chưa có điểm'}
      </div>
      <div className="dash-subject-label" style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{label}</div>
      <div className="dash-subject-bar" style={{ height: 4, borderRadius: 2, marginTop: 8, background: '#E5E7EB', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 2, background: color, width: `${pct}%`, transition: 'width 600ms' }} />
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

type LoadState = 'loading' | 'ok' | 'error';

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userName = user?.name ?? 'bạn';

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [exams,     setExams]     = useState<ExamOut[]>([]);
  const [results,   setResults]   = useState<BatchResultOut[]>([]);
  // the recent kỳ thi opened on a phone (its details shown under its row)
  const [openExamId, setOpenExamId] = useState<number | null>(null);

  const load = async () => {
    setLoadState('loading');
    try {
      const [examList, resultList] = await Promise.all([
        examsApi.list(),
        resultsApi.list({ limit: 500 }),
      ]);
      setExams(examList);
      setResults(resultList.items);
      setLoadState('ok');
      console.log('[Dashboard] exams', examList.length);
      console.log('[Dashboard] results', resultList.items.length);
    } catch (err) {
      console.warn('[Dashboard] load failed:', err);
      setLoadState('error');
    }
  };

  useEffect(() => { load(); }, []);

  // 2026-10-07 "Điểm TB 0.00": the saved total_score of a phiếu isn't its
  // điểm (it was 0 for phiếu saved before their đáp án could be matched).
  // Score every phiếu like Kết quả / Thống kê do: its own mẫu phiếu, the đáp
  // án of its own mã đề, thang 10.
  const [schemas, setSchemas] = useState<Map<number, TemplateSchema>>(new Map());
  const omrRows = useMemo(
    () => results.map(it => ({ r: dbRowToOmrResult(it), examId: it.exam_id ?? null })),
    [results],
  );
  useEffect(() => {
    const ids = [...new Set(omrRows.map(x => x.r)
      .filter(r => r.template_type === 'custom' && r.template_id != null)
      .map(r => r.template_id as number))].filter(id => !schemas.has(id));
    if (!ids.length) return;
    Promise.all(ids.map(id => customFormsApi.get(id).then(d => [id, buildSchemaFromDetail(d)] as const).catch(() => null)))
      .then(got => setSchemas(prev => {
        const next = new Map(prev);
        for (const g of got) if (g) next.set(g[0], g[1]);
        return next;
      }));
  }, [omrRows]); // eslint-disable-line react-hooks/exhaustive-deps
  const scoreById = useMemo(() => {
    const opts = buildTemplateOptionsFromRows(omrRows.map(x => x.r), null, schemas);
    const schemaOf = (r: OmrGradeResult): TemplateSchema =>
      opts.find(o => o.key === getRowTemplateKey(r, null))?.templateSchema ?? { infoFields: [], answerSections: [] };
    const m = new Map<number, number | null>();
    for (const x of scoreRows(omrRows, loadAnswerKey(), schemaOf)) if (x.r.db_id != null) m.set(x.r.db_id, x.score);
    return m;
  }, [omrRows, schemas]);

  // ── Derived stats ─────────────────────────────────────────────────────────

  const totalExams  = exams.length;
  const totalSheets = results.length;

  const needsReviewCount = results.filter(resultNeedsReview).length;
  const okCount          = totalSheets - needsReviewCount;

  // Average score: only valid scores >= 0
  const validScores = results
    .map(r => scoreById.get(r.id))
    .filter((s): s is number => s != null && Number.isFinite(s));
  const avgScore = validScores.length
    ? validScores.reduce((a, b) => a + b, 0) / validScores.length
    : null;

  // Progress per exam: count results whose exam_id matches
  const examById = new Map(exams.map(e => [e.id, e]));

  interface ProgressEntry { exam: ExamOut; graded: number }
  const progressByExam: ProgressEntry[] = exams.map(exam => ({
    exam,
    graded: results.filter(r => Number(r.exam_id) === Number(exam.id)).length,
  }));
  console.log('[Dashboard] progressByExam', progressByExam.map(p => `${p.exam.name}: ${p.graded}/${getExamStudentCount(p.exam) ?? '?'}`));

  // Bar chart data (top 5 by creation date)
  const recentExams = [...progressByExam]
    .sort((a, b) => b.exam.created_at.localeCompare(a.exam.created_at))
    .slice(0, 5);

  // Subject average: group results by their exam's subject
  const subjectMap = new Map<string, number[]>();
  for (const r of results) {
    const score = scoreById.get(r.id);
    if (score == null || !Number.isFinite(score)) continue;
    const exam = examById.get(r.exam_id ?? -1);
    const subject = exam?.subject?.trim() || null;
    if (!subject) continue;
    if (!subjectMap.has(subject)) subjectMap.set(subject, []);
    subjectMap.get(subject)!.push(score);
  }

  const subjectScores: { label: string; avg: number | null; color: string }[] = [];
  let colorIdx = 0;
  // Include subjects from exams even if they have no results yet
  const allSubjects = Array.from(new Set(exams.map(e => e.subject?.trim()).filter(Boolean))) as string[];
  for (const subj of allSubjects) {
    const scores = subjectMap.get(subj);
    const avg = scores && scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;
    subjectScores.push({ label: subj, avg, color: SUBJECT_COLORS[colorIdx++ % SUBJECT_COLORS.length] });
  }
  // subjects that have a score first ("Chưa có điểm" ones after them)
  subjectScores.sort((a, b) => Number(b.avg !== null) - Number(a.avg !== null));

  // Donut slices
  const sheetStatusData: Slice[] = [
    { label: 'Cần kiểm tra', count: needsReviewCount, color: '#C8102E' },
    { label: 'Ổn',           count: okCount,          color: '#39B54A' },
  ];

  // ── Render helpers ────────────────────────────────────────────────────────

  const progressBadgeColor = (graded: number, total: number | null): 'green' | 'yellow' | 'gray' => {
    if (total !== null && total > 0 && graded >= total) return 'green';
    if (graded > 0) return 'yellow';
    return 'gray';
  };

  // ── Loading / error states ────────────────────────────────────────────────

  if (loadState === 'loading') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
        <PageHeader title="Dashboard" subtitle="Đang tải dữ liệu…" />
        <div style={{ padding: '64px 28px', textAlign: 'center', color: '#9CA3AF', fontSize: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <Database size={32} color="#E5E7EB" />
          Đang tải từ database…
        </div>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
        <PageHeader title="Dashboard" subtitle="Không tải được dữ liệu" />
        <div style={{ padding: '48px 28px', textAlign: 'center' }}>
          <WifiOff size={32} color="#FECACA" style={{ margin: '0 auto 12px' }} />
          <div style={{ fontSize: 15, fontWeight: 700, color: '#991B1B', marginBottom: 8 }}>Không kết nối được database</div>
          <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 20 }}>Vui lòng kiểm tra backend và thử lại.</div>
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={load}>Thử lại</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader title="Dashboard" subtitle="Tổng quan kỳ thi, phiếu đã chấm và các mục cần kiểm tra" />

      <div className="dash-content" style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ── Welcome banner ───────────────────────────────────────────────── */}
        <div className="dash-hero" style={{
          background: 'linear-gradient(135deg, #C8102E 60%, #a00d24)',
          borderRadius: 14, padding: '28px 32px',
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', right: 24, top: 0, bottom: 0, display: 'flex', alignItems: 'center', opacity: 0.08 }}>
            <span style={{ fontSize: 120, fontWeight: 900, color: '#fff', letterSpacing: -4 }}>VJU</span>
          </div>
          <div style={{ position: 'relative' }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
              HỆ THỐNG CHẤM PHIẾU
            </div>
            <div className="dash-hero-title" style={{ fontSize: 26, fontWeight: 800, color: '#fff', lineHeight: 1.2, marginBottom: 20 }}>
              Xin chào, <br />{userName} 👋
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Button size="md" onClick={() => navigate('/app/upload')}
                style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', border: '1.5px solid rgba(255,255,255,0.5)' }}>
                ↑ Chấm phiếu
              </Button>
              <Button size="md" onClick={() => navigate('/app/exams')}
                style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', border: '1.5px solid rgba(255,255,255,0.5)' }}>
                + Tạo kỳ thi
              </Button>
            </div>
          </div>
        </div>

        {/* ── Stat cards ───────────────────────────────────────────────────── */}
        <div className="dash-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          <StatCard
            label="Kỳ thi"
            value={totalExams}
            sub="Tổng số kỳ thi"
            accent="#C8102E"
            icon={<Calendar size={18} />}
          />
          <StatCard
            label="Phiếu"
            value={totalSheets}
            sub="Tổng phiếu đã chấm"
            accent="#066AAB"
            icon={<ScanLine size={18} />}
          />
          <StatCard
            label="Cần xem"
            value={needsReviewCount}
            sub="Phiếu cần kiểm tra"
            accent="#FCB900"
            icon={<AlertTriangle size={18} />}
          />
          <StatCard
            label="Điểm TB"
            value={avgScore !== null ? avgScore.toFixed(2) : '—'}
            sub="Điểm trung bình"
            accent="#39B54A"
            icon={<TrendingUp size={18} />}
          />
        </div>

        {/* ── Empty state when no results yet ─────────────────────────────── */}
        {totalSheets === 0 && (
          <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 12, padding: '16px 20px', fontSize: 13, color: '#92400E', display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={16} />
            <span>
              Chưa có phiếu nào được chấm.{' '}
              <button
                onClick={() => navigate('/app/upload')}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#C8102E', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, padding: 0 }}
              >
                Vào Upload &amp; Chấm phiếu →
              </button>
            </span>
          </div>
        )}

        {/* ── Bottom row: bar chart + donut ────────────────────────────────── */}
        <div className="dash-bottom-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>

          {/* Bar chart: progress per exam */}
          <Card>
            <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 700, color: '#1E1E1E' }}>
              Phiếu theo kỳ thi{' '}
              <span style={{ color: '#9CA3AF', fontWeight: 400 }}>
                {recentExams.length} kỳ thi gần nhất
              </span>
            </h3>
            {recentExams.length === 0 ? (
              <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9CA3AF', fontSize: 12 }}>
                Chưa có kỳ thi
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', minHeight: 80, marginBottom: 12 }}>
                {recentExams.map(({ exam, graded }, i) => {
                  const sc  = getExamStudentCount(exam);
                  // 2026-08-04: chấm bù/chấm lại có thể khiến graded > sĩ số
                  // đăng ký (hoặc sĩ số chưa nhập/nhập thấp) — pct khi đó > 1
                  // và cột render cao hàng nghìn px, tràn đè lên nội dung
                  // xung quanh (thấy rõ trên màn hình hẹp di động). Chặn ở 1.
                  const pctRaw = sc !== null && sc > 0
                    ? graded / sc
                    : graded > 0 ? 1 : 0;
                  const pct = Math.min(1, pctRaw);
                  const h = Math.max(8, pct * 80);
                  return (
                    <div key={i} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      {/* the number itself — a 0-phiếu kỳ thi used to be just a pale stripe */}
                      <span style={{ fontSize: 11, fontWeight: 700, color: graded > 0 ? '#C8102E' : '#9CA3AF' }}>
                        {graded}{sc !== null && sc > 0 ? `/${sc}` : ''}
                      </span>
                      <div
                        style={{ width: '100%', borderRadius: 4, background: graded > 0 ? '#C8102E' : '#FEECEC', height: h }}
                        title={`${exam.name}: ${graded}/${sc ?? '?'} phiếu`}
                      />
                      <span title={exam.name} style={{ fontSize: 9, color: '#9CA3AF', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                        {exam.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Donut: sheet status */}
          <Card>
            <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 700, color: '#1E1E1E' }}>
              Tình trạng phiếu{' '}
              <span style={{ color: '#9CA3AF', fontWeight: 400 }}>{totalSheets} phiếu đã chấm</span>
            </h3>
            <DonutChart data={sheetStatusData} centerLabel="phiếu" />
          </Card>
        </div>

        {/* ── Recent exams table ───────────────────────────────────────────── */}
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#1E1E1E' }}>Kỳ thi gần đây</h3>
            <Button size="sm" variant="secondary" icon={<ClipboardList size={14} />} onClick={() => navigate('/app/exams')}>
              Xem tất cả
            </Button>
          </div>

          {progressByExam.length === 0 ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9CA3AF', fontSize: 13 }}>
              Chưa có kỳ thi nào.{' '}
              <button
                onClick={() => navigate('/app/exams')}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#C8102E', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, padding: 0 }}
              >
                Tạo kỳ thi →
              </button>
            </div>
          ) : (
            <div className="dash-table-scroll">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#C8102E' }}>
                    {['Tên kỳ thi', 'Môn học · Học kỳ', 'Ngày thi', 'SV', 'Tiến độ'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#fff', fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...progressByExam]
                    .sort((a, b) => b.exam.created_at.localeCompare(a.exam.created_at))
                    .slice(0, 8)
                    .map(({ exam, graded }, i) => {
                      const sc = getExamStudentCount(exam);
                      const studentStr    = sc !== null ? String(sc) : '—';
                      const progressLabel = sc !== null ? `${graded}/${sc}` : `${graded}/—`;
                      const subjectLabel  = [exam.subject, exam.semester ? semesterLabel(exam.semester) : ''].filter(Boolean).join(' · ') || '—';
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #F3F4F6', background: '#fff' }}>
                          <td style={{ padding: '11px 16px', fontWeight: 600, color: '#1E1E1E' }}>{exam.name}</td>
                          <td style={{ padding: '11px 16px', color: '#6B7280' }}>{subjectLabel}</td>
                          <td style={{ padding: '11px 16px', color: '#6B7280' }}>{fmtDate(exam.exam_date)}</td>
                          <td style={{ padding: '11px 16px', color: '#374151' }}>{studentStr}</td>
                          <td style={{ padding: '11px 16px' }}>
                            <Badge
                              color={progressBadgeColor(graded, sc)}
                              title={`${graded} phiếu đã chấm / ${sc ?? '?'} sinh viên dự kiến`}
                            >
                              {progressLabel}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}

          {/* 2026-10-07 "thế còn cái này thì sao": on a phone the 5-column table
              had to be scrolled sideways. Each kỳ thi is one short row there:
              name, môn · học kỳ · ngày thi below it, tiến độ on the right;
              tapping it shows the kỳ thi's details right under it ("ấn vào thì
              nó ra cái bảng chi tiết"), with Sửa kỳ thi / Xem kết quả.
              The table stays on a computer. */}
          {progressByExam.length > 0 && (
            <div className="dash-recent-list">
              {[...progressByExam]
                .sort((a, b) => b.exam.created_at.localeCompare(a.exam.created_at))
                .slice(0, 8)
                .map(({ exam, graded }) => {
                  const sc = getExamStudentCount(exam);
                  const sub = [
                    exam.subject,
                    exam.semester ? semesterLabel(exam.semester) : '',
                    exam.exam_date ? fmtDate(exam.exam_date) : '',
                  ].filter(Boolean).join(' · ');
                  const open = openExamId === exam.id;
                  const when = [exam.exam_date ? fmtDate(exam.exam_date) : '', exam.exam_time ?? ''].filter(Boolean).join(' ');
                  const details: [string, string][] = [
                    ['Môn học',    [exam.subject, exam.exam_code].filter(Boolean).join(' · ') || '—'],
                    ['Học kỳ',     [exam.semester ? semesterLabel(exam.semester) : '', exam.academic_year ?? ''].filter(Boolean).join(' · ') || '—'],
                    ['Ngày thi',   when || '—'],
                    ['Phòng',      exam.room || '—'],
                    ['Giảng viên', lecturerDisplay(exam)],
                    ['SV',         sc !== null ? String(sc) : '—'],
                    ['Tiến độ',    `${graded}/${sc ?? '—'} phiếu`],
                  ];
                  return (
                    <div key={exam.id}>
                    <button
                      type="button"
                      onClick={() => setOpenExamId(open ? null : exam.id)}
                      aria-expanded={open}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                        padding: '12px 16px', border: 'none', borderTop: '1px solid #F3F4F6',
                        background: '#fff', cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#1E1E1E', lineHeight: 1.35 }}>{exam.name}</div>
                        <div style={{ fontSize: 12, color: '#6B7280', marginTop: 3 }}>{sub || '—'}</div>
                      </div>
                      <Badge
                        color={progressBadgeColor(graded, sc)}
                        title={`${graded} phiếu đã chấm / ${sc ?? '?'} sinh viên dự kiến`}
                      >
                        {graded}/{sc ?? '—'}
                      </Badge>
                      <ChevronDown size={16} color="#9CA3AF" style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 200ms' }} />
                    </button>
                    {open && (
                      <div style={{ margin: '0 16px 14px', border: '1px solid #EEE', borderRadius: 10, overflow: 'hidden' }}>
                        {details.map(([k, v], j) => (
                          <div key={k} style={{ display: 'flex', gap: 12, padding: '8px 12px', fontSize: 13, background: j % 2 ? '#FAFAFA' : '#fff' }}>
                            <span style={{ width: 84, flexShrink: 0, color: '#6B7280', fontWeight: 600 }}>{k}</span>
                            <span style={{ flex: 1, minWidth: 0, color: '#1E1E1E', textAlign: 'right', overflowWrap: 'anywhere' }}>{v}</span>
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid #F3F4F6' }}>
                          <button
                            type="button"
                            onClick={() => navigate('/app/exams', { state: { editExamId: exam.id } })}
                            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', borderRadius: 9999, border: '1.5px solid #E5E7EB', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                          >
                            <Pencil size={13} /> Sửa kỳ thi
                          </button>
                          <button
                            type="button"
                            onClick={() => navigate('/app/results', { state: { openExam: { id: exam.id, name: exam.name } } })}
                            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', borderRadius: 9999, border: 'none', background: '#C8102E', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                          >
                            <BarChart3 size={13} /> Xem kết quả
                          </button>
                        </div>
                      </div>
                    )}
                    </div>
                  );
                })}
            </div>
          )}
        </Card>

        {/* ── Subject averages ─────────────────────────────────────────────── */}
        <Card>
          <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 700, color: '#1E1E1E' }}>
            Điểm trung bình theo môn
          </h3>
          {subjectScores.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9CA3AF', fontSize: 13, padding: '16px 0' }}>
              Chưa có dữ liệu.
            </div>
          ) : (
            <div className="dash-subject-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              {subjectScores.map(s => (
                <SubjectBar key={s.label} label={s.label} avg={s.avg} color={s.color} />
              ))}
            </div>
          )}
        </Card>

      </div>
    </div>
  );
}
