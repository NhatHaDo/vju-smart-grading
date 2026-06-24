import { Fragment, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Trash2, Search } from 'lucide-react';
import PageHeader from '../components/layout/PageHeader';
import ExamDatePicker from '../components/common/ExamDatePicker';
import {
  SEMESTER_OPTIONS, LECTURER_TITLE_OPTIONS, FACULTY_OPTIONS, TRAINING_PROGRAMS,
  semesterLabel, facultyLabel, lecturerDisplay, currentAcademicYear,
} from '../constants/examMeta';
import type { ExamOut, ExamFormData } from '../types/exam';
import { emptyForm, examOutToForm, formToPayload } from '../types/exam';
import { examsApi } from '../services/apiClient';

/** Format "YYYY-MM-DD" → "dd/MM/yyyy" for display */
function fmtExamDate(s: string | null | undefined): string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return s ?? '';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

// ── Inline styles matching old vju-omr-web wizard ────────────────────────────
const W = {
  card: {
    background: '#fff',
    borderRadius: 20,
    boxShadow: '0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)',
    maxWidth: 600,
    margin: '0 auto',
    padding: '28px 28px 24px',
  } as React.CSSProperties,
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    borderRadius: 12,
    border: '1.5px solid #eee',
    padding: '10px 14px',
    fontSize: 14,
    outline: 'none',
    background: '#fafafa',
    color: '#1E1E1E',
    fontFamily: 'inherit',
  } as React.CSSProperties,
  label: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    fontSize: 12,
    fontWeight: 700,
    color: '#555',
    letterSpacing: '0.02em',
  } as React.CSSProperties,
  btnNext: {
    width: '100%', height: 48, borderRadius: 12, border: 'none',
    background: '#C8102E', color: '#fff', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  } as React.CSSProperties,
  btnSubmit: {
    width: '100%', height: 48, borderRadius: 12, border: 'none',
    background: '#16a34a', color: '#fff', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  } as React.CSSProperties,
  btnBack: {
    width: '100%', height: 48, borderRadius: 12, border: 'none',
    background: '#f5f4f2', color: '#333', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  } as React.CSSProperties,
};

const STEP_LABELS = ['Thông tin môn học', 'Lớp & Giảng viên', 'Xác nhận'];

// ── Sub-components ────────────────────────────────────────────────────────────
function ConfirmRow({ label, value }: { label: string; value: string | number | undefined | null }) {
  if (value === '' || value === null || value === undefined) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid #F3F4F6', gap: 12 }}>
      <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 600, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#1E1E1E', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ExamPage() {
  const navigate = useNavigate();

  // ── Exam list state ──
  const [exams,    setExams]   = useState<ExamOut[]>([]);
  const [loading,  setLoading] = useState(true);
  const [apiErr,   setApiErr]  = useState('');
  const [authErr,  setAuthErr] = useState(false);
  const [search,  setSearch]  = useState('');

  // ── Wizard state ──
  const [form,       setForm]       = useState<ExamFormData>(emptyForm(currentAcademicYear()));
  const [editingId,  setEditingId]  = useState<number | null>(null);
  const [formError,  setFormError]  = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [step,       setStep]       = useState(0);
  const [animDir,    setAnimDir]    = useState<'right' | 'left'>('right');
  const [animKey,    setAnimKey]    = useState(0);

  // ── Load exams ──
  const isAuthError = (msg: string) =>
    msg.includes('Phiên đăng nhập') || msg.includes('Not authenticated') || msg.includes('xác thực');

  const loadExams = useCallback(async () => {
    setLoading(true);
    setApiErr('');
    setAuthErr(false);
    try {
      const data = await examsApi.list();
      setExams(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Không tải được danh sách kỳ thi';
      if (isAuthError(msg)) { setAuthErr(true); } else { setApiErr(msg); }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadExams(); }, [loadExams]);

  // ── Wizard helpers ──
  const updateField = (key: keyof ExamFormData, value: string) => {
    setForm(prev => {
      const next = { ...prev, [key]: value };
      // Reset training_program when faculty changes
      if (key === 'faculty' && !(TRAINING_PROGRAMS[value] ?? []).includes(next.training_program)) {
        next.training_program = '';
      }
      return next;
    });
  };

  const resetWizard = () => {
    setEditingId(null);
    setForm(emptyForm(currentAcademicYear()));
    setFormError('');
    setStep(0);
    setAnimDir('right');
    setAnimKey(k => k + 1);
  };

  const startEdit = (exam: ExamOut) => {
    setEditingId(exam.id);
    setForm(examOutToForm(exam));
    setFormError('');
    setStep(0);
    setAnimDir('right');
    setAnimKey(k => k + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ── Validation ──
  const validateStep1 = (): string => {
    if (!form.name.trim())         return 'Vui lòng nhập tên kỳ thi';
    if (!form.subject_name.trim()) return 'Vui lòng nhập tên môn học';
    if (!form.subject_code.trim()) return 'Vui lòng nhập mã môn học';
    if (!form.semester)            return 'Vui lòng chọn học kỳ';
    if (!/^20\d{2}\/20\d{2}$/.test(form.academic_year.trim())) return 'Năm học phải có dạng 2025/2026';
    return '';
  };
  const validateStep2 = (): string => {
    if (!form.faculty)           return 'Vui lòng chọn khoa/viện';
    if (!form.training_program)  return 'Vui lòng chọn chương trình đào tạo';
    if (form.student_count !== '') {
      const n = parseInt(form.student_count, 10);
      if (isNaN(n) || n < 1 || form.student_count.includes('.')) {
        return 'Sĩ số lớp phải là số nguyên lớn hơn 0';
      }
    }
    return '';
  };

  const goNext = () => {
    const err = step === 0 ? validateStep1() : validateStep2();
    if (err) { setFormError(err); return; }
    setFormError('');
    setAnimDir('right');
    setAnimKey(k => k + 1);
    setStep(s => s + 1);
  };
  const goBack = () => {
    setFormError('');
    setAnimDir('left');
    setAnimKey(k => k + 1);
    setStep(s => s - 1);
  };

  const save = async () => {
    const err = validateStep1() || validateStep2();
    if (err) { setFormError(err); return; }
    setSubmitting(true);
    setFormError('');
    try {
      const payload = formToPayload(form);
      if (editingId !== null) {
        await examsApi.update(editingId, payload);
      } else {
        await examsApi.create(payload);
      }
      await loadExams();
      resetWizard();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Không lưu được kỳ thi';
      if (isAuthError(msg)) { setAuthErr(true); } else { setFormError(msg); }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (exam: ExamOut) => {
    if (!window.confirm(`Xoá kỳ thi "${exam.name}"?`)) return;
    try {
      await examsApi.delete(exam.id);
      await loadExams();
      if (editingId === exam.id) resetWizard();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Không xoá được kỳ thi');
    }
  };

  // ── Input helpers ──
  const availablePrograms = TRAINING_PROGRAMS[form.faculty] ?? [];

  const inp = (key: keyof ExamFormData, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      style={W.input}
      value={form[key]}
      onChange={e => updateField(key, e.target.value)}
      {...props}
    />
  );
  const sel = (
    key: keyof ExamFormData,
    options: Array<string | { value: string; label: string }>,
    props: React.SelectHTMLAttributes<HTMLSelectElement> & { placeholder?: string } = {},
  ) => {
    const { placeholder, ...rest } = props;
    return (
      <select style={W.input} value={form[key]} onChange={e => updateField(key, e.target.value)} {...rest}>
        <option value="">{placeholder ?? '-- Chọn --'}</option>
        {options.map(opt => typeof opt === 'string'
          ? <option key={opt} value={opt}>{opt}</option>
          : <option key={opt.value} value={opt.value}>{opt.label}</option>
        )}
      </select>
    );
  };
  const lbl = (text: string, required: boolean, child: React.ReactNode) => (
    <label style={W.label}>
      <span>{text}{required && <span style={{ color: '#C8102E' }}> *</span>}</span>
      {child}
    </label>
  );

  // ── Filtered list ──
  const filtered = exams.filter(e =>
    e.name.toLowerCase().includes(search.toLowerCase()) ||
    e.subject.toLowerCase().includes(search.toLowerCase()),
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title="Kỳ thi"
        subtitle="Quản lý kỳ thi, môn học, lớp và thông tin giảng viên"
      />

      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ── Auth error banner ────────────────────────────────────────────── */}
        {authErr && (
          <div style={{ padding: '14px 18px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ color: '#991B1B', fontSize: 14, fontWeight: 600 }}>
              🔐 Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.
            </div>
            <button
              onClick={() => navigate('/login')}
              style={{ flexShrink: 0, padding: '8px 18px', borderRadius: 9999, border: 'none', background: '#C8102E', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Đăng nhập lại
            </button>
          </div>
        )}

        {/* ── Wizard card ─────────────────────────────────────────────────── */}
        <div style={W.card}>

          {/* Stepper */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', marginBottom: 28 }}>
            {STEP_LABELS.map((label, i) => {
              const done   = i < step;
              const active = i === step;
              return (
                <Fragment key={i}>
                  {i > 0 && (
                    <div style={{
                      flex: 1, height: 3, maxWidth: 56, marginTop: 14,
                      background: done ? '#C8102E' : '#E5E7EB',
                      transition: 'background 300ms',
                    }} />
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 700,
                      background: done ? '#C8102E' : active ? '#fff' : '#E5E7EB',
                      color:      done ? '#fff'    : active ? '#C8102E' : '#9CA3AF',
                      border: active ? '2.5px solid #C8102E' : 'none',
                      boxShadow: active ? '0 0 0 4px rgba(200,16,46,0.15)' : 'none',
                      transition: 'all 300ms',
                    }}>
                      {done ? '✓' : i + 1}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', color: (active || done) ? '#C8102E' : '#9CA3AF' }}>
                      {label}
                    </span>
                  </div>
                </Fragment>
              );
            })}
          </div>

          {/* Error banner */}
          {formError && (
            <div style={{ marginBottom: 16, padding: '10px 14px', background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 10, color: '#991B1B', fontSize: 13, fontWeight: 600 }}>
              {formError}
            </div>
          )}

          {/* Animated step content */}
          <div key={animKey} className={`wiz-enter-${animDir}`}>

            {/* ─ Step 1: Môn học ─ */}
            {step === 0 && (
              <div>
                <div style={{ marginBottom: 20 }}>
                  <h3 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: '#1E1E1E' }}>
                    {editingId !== null ? 'Sửa kỳ thi' : 'Tạo kỳ thi mới'}
                  </h3>
                  <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Điền thông tin môn học và kỳ thi</p>
                </div>
                <div style={{ display: 'grid', gap: 14 }}>
                  {lbl('Tên kỳ thi', true, inp('name', { placeholder: 'Ví dụ: Kiểm tra giữa kỳ – CNTT2025' }))}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="wiz-grid-2">
                    {lbl('Tên môn học', true, inp('subject_name', { placeholder: 'Ví dụ: Lập trình Web' }))}
                    {lbl('Mã môn học', true, inp('subject_code', { placeholder: 'Ví dụ: INT3306' }))}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="wiz-grid-2">
                    {lbl('Học kỳ', true, sel('semester', SEMESTER_OPTIONS, { placeholder: '-- Chọn học kỳ --' }))}
                    {lbl('Năm học', true, inp('academic_year', { placeholder: '20__/20__' }))}
                  </div>
                </div>
              </div>
            )}

            {/* ─ Step 2: Lớp & Giảng viên ─ */}
            {step === 1 && (
              <div>
                <div style={{ marginBottom: 20 }}>
                  <h3 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: '#1E1E1E' }}>Lớp & Giảng viên</h3>
                  <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Thông tin lớp học, lịch thi và giảng viên</p>
                </div>
                <div style={{ display: 'grid', gap: 14 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="wiz-grid-2">
                    {lbl('Khoa / viện', true, sel('faculty', FACULTY_OPTIONS, { placeholder: '-- Chọn khoa/viện --' }))}
                    {lbl('Chương trình đào tạo', true,
                      <select
                        style={{ ...W.input, opacity: !form.faculty ? 0.6 : 1 }}
                        value={form.training_program}
                        onChange={e => updateField('training_program', e.target.value)}
                        disabled={!form.faculty}
                      >
                        <option value="">{form.faculty ? '-- Chọn chương trình --' : 'Chọn khoa/viện trước'}</option>
                        {availablePrograms.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="wiz-grid-2">
                    {lbl('Lớp / mã lớp', false, inp('class_name', { placeholder: 'Ví dụ: CNTT2022-01' }))}
                    {lbl('Sĩ số lớp', false, inp('student_count', { type: 'number', min: 1, step: 1, placeholder: 'Ví dụ: 60' }))}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12 }}>
                    {lbl('Chức danh GV', false, sel('lecturer_title', LECTURER_TITLE_OPTIONS))}
                    {lbl('Tên giảng viên', false, inp('lecturer_name', { placeholder: 'Nhập tên giảng viên' }))}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="wiz-grid-2">
                    {lbl('Ngày thi', false,
                      <ExamDatePicker
                        value={form.exam_date}
                        onChange={v => updateField('exam_date', v)}
                      />
                    )}
                    {lbl('Thời gian thi', false, inp('exam_time', { type: 'time' }))}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="wiz-grid-2">
                    {lbl('Phòng thi', false, inp('room',  { placeholder: 'Ví dụ: P.301' }))}
                    {lbl('Ca thi',    false, inp('shift', { placeholder: 'Ví dụ: Ca 1' }))}
                  </div>
                  {lbl('Ghi chú', false,
                    <textarea
                      style={{ ...W.input, minHeight: 72, resize: 'vertical' }}
                      placeholder="Ghi chú thêm về kỳ thi..."
                      value={form.notes}
                      onChange={e => updateField('notes', e.target.value)}
                    />
                  )}
                </div>
              </div>
            )}

            {/* ─ Step 3: Xác nhận ─ */}
            {step === 2 && (
              <div>
                <div style={{ marginBottom: 20 }}>
                  <h3 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: '#1E1E1E' }}>Xác nhận thông tin</h3>
                  <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Kiểm tra lại trước khi lưu</p>
                </div>
                <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12, padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 20, lineHeight: '1' }}>✅</span>
                  <div>
                    <div style={{ fontWeight: 700, color: '#166534', fontSize: 14 }}>Đã điền đủ thông tin bắt buộc</div>
                    <div style={{ color: '#15803D', fontSize: 12, marginTop: 2 }}>Bạn có thể chỉnh sửa sau khi tạo kỳ thi.</div>
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 14 }}>
                  <div style={{ background: '#FAFAFA', borderRadius: 12, padding: '14px 16px', border: '1px solid #F3F4F6' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#C8102E', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>Môn học</div>
                    <ConfirmRow label="Tên kỳ thi"  value={form.name} />
                    <ConfirmRow label="Môn học"     value={form.subject_name} />
                    <ConfirmRow label="Mã môn"      value={form.subject_code} />
                    <ConfirmRow label="Học kỳ"      value={semesterLabel(form.semester)} />
                    <ConfirmRow label="Năm học"     value={form.academic_year} />
                  </div>
                  <div style={{ background: '#FAFAFA', borderRadius: 12, padding: '14px 16px', border: '1px solid #F3F4F6' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#C8102E', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>Lớp & Giảng viên</div>
                    <ConfirmRow label="Khoa / viện"  value={facultyLabel(form.faculty)} />
                    <ConfirmRow label="Chương trình" value={form.training_program} />
                    <ConfirmRow label="Lớp"          value={form.class_name} />
                    <ConfirmRow label="Sĩ số"        value={form.student_count} />
                    <ConfirmRow label="Giảng viên"   value={lecturerDisplay(form)} />
                    <ConfirmRow label="Ngày thi"     value={fmtExamDate(form.exam_date)} />
                    <ConfirmRow label="Thời gian"    value={form.exam_time} />
                    <ConfirmRow label="Phòng thi"    value={form.room} />
                    <ConfirmRow label="Ca thi"       value={form.shift} />
                    <ConfirmRow label="Ghi chú"      value={form.notes} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Navigation buttons */}
          <div style={{ marginTop: 24 }}>
            {step === 0 && (
              <button className="wiz-btn-red" style={W.btnNext} onClick={goNext}>Tiếp theo →</button>
            )}
            {step === 1 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
                <button className="wiz-btn-gray" style={W.btnBack} onClick={goBack}>← Quay lại</button>
                <button className="wiz-btn-red"  style={W.btnNext} onClick={goNext}>Tiếp theo →</button>
              </div>
            )}
            {step === 2 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
                <button className="wiz-btn-gray"  style={W.btnBack}   onClick={goBack} disabled={submitting}>← Quay lại</button>
                <button className="wiz-btn-green" style={W.btnSubmit} onClick={() => void save()} disabled={submitting}>
                  {submitting ? 'Đang lưu...' : editingId !== null ? '💾 Lưu thay đổi' : '✅ Tạo kỳ thi'}
                </button>
              </div>
            )}
          </div>

          {editingId !== null && (
            <div style={{ marginTop: 14, textAlign: 'center' }}>
              <button
                onClick={resetWizard}
                style={{ background: 'none', border: 'none', color: '#9CA3AF', fontSize: 13, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}
              >
                Huỷ sửa
              </button>
            </div>
          )}
        </div>

        {/* ── Exam list ────────────────────────────────────────────────────── */}
        <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 14, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1E1E1E' }}>Danh sách kỳ thi</h3>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9CA3AF', pointerEvents: 'none' }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Tìm kỳ thi..."
                style={{ padding: '8px 12px 8px 30px', borderRadius: 9999, border: '1.5px solid #E5E7EB', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: 220 }}
              />
            </div>
          </div>

          {apiErr && (
            <div style={{ padding: '10px 14px', background: '#FEE2E2', borderRadius: 8, color: '#991B1B', fontSize: 13, marginBottom: 12 }}>
              {apiErr} — <button onClick={() => void loadExams()} style={{ background: 'none', border: 'none', color: '#C8102E', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>Thử lại</button>
            </div>
          )}

          {loading ? (
            <div style={{ color: '#9CA3AF', fontSize: 14, padding: '20px 0', textAlign: 'center' }}>Đang tải...</div>
          ) : filtered.length === 0 ? (
            <div style={{ color: '#9CA3AF', fontSize: 14, padding: '20px 0', textAlign: 'center' }}>
              {exams.length === 0 ? 'Chưa có kỳ thi nào. Hãy tạo kỳ thi đầu tiên ở trên.' : 'Không tìm thấy kỳ thi phù hợp.'}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#C8102E' }}>
                    {['Tên kỳ thi', 'Môn học', 'Học kỳ / Năm học', 'Giảng viên', 'SV / Phiếu', 'Thao tác'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 600, color: '#fff', fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((exam, i) => (
                    <tr key={exam.id} style={{ borderBottom: '1px solid #F3F4F6', background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                      <td style={{ padding: '11px 14px', fontWeight: 600, color: '#1E1E1E' }}>
                        <div>{exam.name}</div>
                        <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                          {new Date(exam.created_at).toLocaleDateString('vi-VN')}
                        </div>
                      </td>
                      <td style={{ padding: '11px 14px', color: '#374151' }}>
                        <div>{exam.subject || '—'}</div>
                        <div style={{ fontSize: 11, color: '#9CA3AF' }}>{exam.exam_code ?? ''}</div>
                      </td>
                      <td style={{ padding: '11px 14px', color: '#6B7280' }}>
                        <div>{exam.semester ? semesterLabel(exam.semester) : '—'}</div>
                        <div style={{ fontSize: 11, color: '#9CA3AF' }}>{exam.academic_year ?? ''}</div>
                      </td>
                      <td style={{ padding: '11px 14px', color: '#6B7280' }}>
                        <div>{lecturerDisplay(exam)}</div>
                        <div style={{ fontSize: 11, color: '#9CA3AF' }}>
                          {exam.exam_date ?? ''}{exam.exam_time ? ` ${exam.exam_time}` : ''}{exam.room ? ` · ${exam.room}` : ''}
                        </div>
                      </td>
                      <td style={{ padding: '11px 14px', color: '#374151', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {exam.total_students} SV · {exam.graded_count} phiếu
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            title="Sửa"
                            onClick={() => startEdit(exam)}
                            style={{ border: '1.5px solid #E5E7EB', borderRadius: 9999, padding: '4px 12px', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
                          >
                            <Pencil size={11} /> Sửa
                          </button>
                          <button
                            title="Xoá"
                            onClick={() => void handleDelete(exam)}
                            style={{ border: '1.5px solid #FECACA', borderRadius: 9999, padding: '4px 12px', background: '#fff', color: '#C8102E', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
                          >
                            <Trash2 size={11} /> Xoá
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
