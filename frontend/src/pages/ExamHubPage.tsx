/**
 * ExamHubPage.tsx — one kỳ thi, everything about it on one screen (phone).
 *
 * "những phần này app của e chưa chia ra được như họ" — the QM app opens a
 * bài and lists Đáp án / Chấm bài / Bài đã chấm / Xuất điểm / Thống kê with a
 * short summary underneath. This page does the same for a kỳ thi: each row
 * opens the existing page with this kỳ thi already selected, and the mã đề
 * answer keys (from the bộ đề trộn attached to it) can be checked right here.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Shuffle, KeyRound, Camera, Upload, ClipboardList, FileSpreadsheet, BarChart3,
  Pencil, ChevronRight, ChevronDown, CheckCircle2, Circle,
} from 'lucide-react';
import { examPapersApi, examsApi, resultsApi } from '../services/apiClient';
import type { ExamOut } from '../types/exam';
import { semesterLabel, lecturerDisplay } from '../constants/examMeta';

type AnswerKey = Awaited<ReturnType<typeof examPapersApi.examAnswerKey>>;

function fmtDate(s: string | null | undefined): string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return s ?? '';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

const RED = '#C8102E';

function Row({ icon, title, sub, onClick, open, badge }: {
  icon: React.ReactNode; title: string; sub?: React.ReactNode; onClick: () => void; open?: boolean; badge?: string;
}) {
  return (
    <button type="button" onClick={onClick} className="exam-hub-row">
      <span className="exam-hub-icon">{icon}</span>
      <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
        <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: '#1E1E1E' }}>{title}</span>
        {sub && <span style={{ display: 'block', fontSize: 12.5, color: '#6B7280', marginTop: 2 }}>{sub}</span>}
      </span>
      {badge && <span className="exam-hub-badge">{badge}</span>}
      {open === undefined ? <ChevronRight size={18} color="#9CA3AF" /> : open ? <ChevronDown size={18} color="#9CA3AF" /> : <ChevronRight size={18} color="#9CA3AF" />}
    </button>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14.5, color: ok ? '#1F2937' : '#9CA3AF', padding: '5px 0' }}>
      {ok ? <CheckCircle2 size={20} color="#16A34A" fill="#DCFCE7" /> : <Circle size={20} color="#D1D5DB" />}
      <span>{children}</span>
    </div>
  );
}

export default function ExamHubPage() {
  const { id } = useParams();
  const examId = Number(id);
  const navigate = useNavigate();
  const [exam, setExam] = useState<ExamOut | null>(null);
  const [error, setError] = useState('');
  const [key, setKey] = useState<AnswerKey | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [openCode, setOpenCode] = useState<string | null>(null);
  // phiếu saved for this kỳ thi (exam.graded_count isn't kept up to date)
  const [graded, setGraded] = useState<number | null>(null);

  useEffect(() => {
    if (!Number.isFinite(examId)) { setError('Không tìm thấy kỳ thi'); return; }
    examsApi.get(examId).then(setExam).catch(() => setError('Không tải được kỳ thi'));
    examPapersApi.examAnswerKey(examId)
      .then(setKey)
      .catch(() => setKey({ byMaDe: {}, papers: [], versions: [] }));
    resultsApi.list({ exam_id: examId, limit: 1 }).then(r => setGraded(r.total)).catch(() => setGraded(null));
  }, [examId]);

  const codes = key ? Object.keys(key.byMaDe).sort() : [];
  const numQuestions = codes.length ? Object.keys(key!.byMaDe[codes[0]]).length : 0;
  const examRef = exam ? { id: exam.id, name: exam.name } : { id: examId, name: '' };
  // hub: lets the page opened from here show "← <kỳ thi>" (AppShell → HubBackBar)
  const go = (to: string, state?: Record<string, unknown>) => navigate(to, { state: { ...state, hub: examRef } });
  const gradedCount = graded ?? exam?.graded_count ?? 0;

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <button type="button" onClick={() => navigate('/app/exams')} className="exam-hub-back"><ArrowLeft size={18} /> Kỳ thi</button>
        <div style={{ marginTop: 16, color: RED, fontSize: 14 }}>{error}</div>
      </div>
    );
  }

  const when = exam ? [fmtDate(exam.exam_date), exam.exam_time ?? '', exam.room ?? ''].filter(Boolean).join(' · ') : '';

  return (
    <div className="exam-hub">
      <div className="exam-hub-top">
        <button type="button" onClick={() => navigate('/app/exams')} className="exam-hub-back" aria-label="Quay lại">
          <ArrowLeft size={20} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#1E1E1E', lineHeight: 1.3 }}>{exam?.name ?? 'Đang tải…'}</div>
          {exam && (
            <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 2 }}>
              {exam.subject}{exam.exam_code ? ` · ${exam.exam_code}` : ''}{when ? ` · ${when}` : ''}
            </div>
          )}
        </div>
      </div>

      <div className="exam-hub-list">
        <Row icon={<Shuffle size={20} />} title="Trộn đề" sub="Trộn đề Word hoặc ngân hàng câu hỏi cho kỳ thi này"
          onClick={() => go('/app/exam-papers', { examId })} />

        <div>
          <Row icon={<KeyRound size={20} />} title="Đáp án"
            sub={key === null ? 'Đang tải…' : codes.length ? `${codes.length} mã đề: ${codes.join(', ')}` : 'Chưa có, trộn đề hoặc nhập khi chấm'}
            open={keyOpen} onClick={() => setKeyOpen(v => !v)} />
          {keyOpen && key && (
            <div className="exam-hub-keys">
              {codes.length === 0 && (
                <div style={{ fontSize: 13.5, color: '#6B7280', lineHeight: 1.5 }}>
                  Kỳ thi chưa gắn bộ đề trộn nào. Bấm <b>Trộn đề</b> ở trên, hoặc nhập đáp án ở bước chấm (Chấm bằng camera / Tải ảnh).
                </div>
              )}
              {codes.map(code => {
                const ans = key.byMaDe[code];
                const open = openCode === code;
                return (
                  <div key={code} className="exam-hub-code">
                    <button type="button" onClick={() => setOpenCode(open ? null : code)} className="exam-hub-code-head">
                      <KeyRound size={16} color="#0F766E" />
                      <span style={{ flex: 1, textAlign: 'left', fontWeight: 600 }}>Mã đề {code}</span>
                      <span style={{ fontSize: 12.5, color: '#6B7280' }}>{Object.keys(ans).length} câu</span>
                      {open ? <ChevronDown size={16} color="#9CA3AF" /> : <ChevronRight size={16} color="#9CA3AF" />}
                    </button>
                    {open && (
                      <div className="exam-hub-answers">
                        {Object.entries(ans).map(([q, a]) => (
                          <span key={q} className="exam-hub-ans"><span style={{ color: '#6B7280' }}>{q.replace(/^Câu\s*/i, '')}</span> <b>{a || '–'}</b></span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {key.papers.length > 0 && (
                <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 6 }}>
                  Từ bộ đề: {key.papers.join(', ')}{key.sheetNames && key.sheets?.length ? ` · phiếu ${key.sheets.map(s => key.sheetNames?.[String(s)] ?? s).join(', ')}` : ''}
                </div>
              )}
            </div>
          )}
        </div>

        <Row icon={<Camera size={20} />} title="Chấm bằng camera" sub="Đưa phiếu vào khung, điểm hiện ngay"
          onClick={() => go('/app/quick-grade', { examId })} />
        <Row icon={<Upload size={20} />} title="Tải ảnh / PDF để chấm" sub="Chấm nhiều phiếu một lần"
          onClick={() => go('/app/upload', { examId })} />
        <Row icon={<ClipboardList size={20} />} title="Bài đã chấm" sub="Xem, kiểm tra và sửa từng bài"
          badge={gradedCount > 0 ? String(gradedCount) : undefined}
          onClick={() => go('/app/results', { openExam: examRef })} />
        <Row icon={<FileSpreadsheet size={20} />} title="Xuất điểm" sub="Excel, CSV, ZIP ảnh bài chấm"
          onClick={() => go('/app/results', { openExam: examRef })} />
        <Row icon={<BarChart3 size={20} />} title="Thống kê" sub="Phổ điểm, câu khó, so sánh mã đề"
          onClick={() => go('/app/analytics', { examId })} />

        {exam && (
          <div className="exam-hub-summary">
            <Check ok={codes.length > 0}>{codes.length ? `${codes.length} mã đề · ${numQuestions} câu` : 'Chưa có đáp án'}</Check>
            <Check ok={gradedCount > 0}>
              {gradedCount} phiếu đã chấm{exam.total_students ? ` / ${exam.total_students} SV` : ''}
            </Check>
            <Check ok={!!exam.semester}>
              {exam.semester ? semesterLabel(exam.semester) : 'Chưa chọn học kỳ'}{exam.academic_year ? ` · ${exam.academic_year}` : ''}
            </Check>
            <Check ok={!!lecturerDisplay(exam)}>GV: {lecturerDisplay(exam) || 'chưa nhập'}</Check>
            <button type="button" onClick={() => go('/app/exams', { editExamId: exam.id })} className="exam-hub-edit">
              <Pencil size={14} /> Sửa thông tin kỳ thi
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
