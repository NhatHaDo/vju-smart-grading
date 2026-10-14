/**
 * PaperFormatFields.tsx — "Trình bày đề" when mixing (2026-10-14), like
 * YoungMix's options: đầu đề (Trường ĐH Việt Nhật or phổ thông), "Câu 1." /
 * "Câu 1:", số câu đầu tiên, đề tiếng Anh, đảo vị trí nhóm câu.
 * The backend applies it when the Word files are made (services/paper_format.py).
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { PaperFormat } from '../../services/apiClient';
import type { ExamOut } from '../../types/exam';

export const DEFAULT_FORMAT: PaperFormat = { header: 'none', label: '.', start: 1, english: false, shuffle_groups: true };

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', border: '1.5px solid #D1D5DB', borderRadius: 8,
  padding: '7px 10px', fontSize: 13.5, fontFamily: 'inherit', outline: 'none', background: '#fff', marginTop: 4,
};
const labelStyle: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: '#374151' };
const checkStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer' };

/** What the backend writes when a line is left empty. */
function placeholders(header: PaperFormat['header'], en: boolean): Record<string, string> {
  if (header === 'school') {
    return en
      ? { org1: 'DEPARTMENT OF EDUCATION AND TRAINING', org2: '…… SCHOOL', title: 'TEST', term: 'School year 2026-2027', subject: 'Mathematics 12' }
      : { org1: 'SỞ GIÁO DỤC VÀ ĐÀO TẠO ……', org2: 'TRƯỜNG ……', title: 'ĐỀ KIỂM TRA', term: 'NĂM HỌC 2026-2027', subject: 'Toán 12' };
  }
  return en
    ? { org1: 'VIETNAM NATIONAL UNIVERSITY, HANOI', org2: 'VNU VIETNAM JAPAN UNIVERSITY', org3: 'Faculty …', title: 'FINAL EXAMINATION',
        term: 'Semester I, academic year 2026-2027', subject: 'Tên học phần' }
    : { org1: 'ĐẠI HỌC QUỐC GIA HÀ NỘI', org2: 'TRƯỜNG ĐẠI HỌC VIỆT NHẬT', org3: 'Khoa … (bỏ trống nếu không cần)',
        title: 'ĐỀ THI KẾT THÚC HỌC PHẦN', term: 'Học kỳ I, năm học 2026-2027', subject: 'Tên học phần' };
}

/** Học kỳ / năm học of a kỳ thi, written for the chosen đầu đề. */
function termOf(exam: ExamOut, header: PaperFormat['header'], en: boolean): string {
  const year = exam.academic_year ?? '';
  const sem = exam.semester === 'HE' ? (en ? 'Summer semester' : 'Học kỳ hè') : exam.semester ? `${en ? 'Semester' : 'Học kỳ'} ${exam.semester}` : '';
  if (header === 'school') return year ? (en ? `School year ${year}` : `NĂM HỌC ${year}`) : '';
  return [sem, year && (en ? `academic year ${year}` : `năm học ${year}`)].filter(Boolean).join(', ');
}

/** Short summary shown while the section is closed. */
export function formatSummary(f: PaperFormat, showGroups: boolean): string {
  const parts = [
    f.header === 'vju' ? 'Đầu đề ĐH Việt Nhật' : f.header === 'school' ? 'Đầu đề phổ thông' : 'Không đầu đề',
    `Câu ${f.start ?? 1}${f.label ?? '.'}`,
    ...(f.english ? ['tiếng Anh'] : []),
    ...(showGroups && f.shuffle_groups === false ? ['nhóm đứng yên'] : []),
  ];
  return parts.join(' · ');
}

export default function PaperFormatFields({ value, onChange, exam, showGroups = true, keepFormat = false, defaultOpen = false }: {
  value: PaperFormat;
  onChange: (f: PaperFormat) => void;
  /** the kỳ thi the bộ đề goes to: fills học phần, mã học phần, học kỳ */
  exam?: ExamOut | null;
  /** "Đảo vị trí nhóm" — only when mixing (it decides the order of the mã đề) */
  showGroups?: boolean;
  /** one Word file: the đầu đề goes above the file's own title */
  keepFormat?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const f = { ...DEFAULT_FORMAT, ...value };
  const set = (patch: Partial<PaperFormat>) => onChange({ ...f, ...patch });
  const en = !!f.english;
  const ph = placeholders(f.header, en);

  // fill học phần / mã học phần / học kỳ from the kỳ thi — only empty boxes
  useEffect(() => {
    if (!exam || f.header === 'none') return;
    const fill: Partial<PaperFormat> = {};
    if (!f.subject && exam.subject) fill.subject = exam.subject;
    if (f.header === 'vju' && !f.subject_code && exam.subject_code) fill.subject_code = exam.subject_code;
    if (!f.term) { const t = termOf(exam, f.header, en); if (t) fill.term = t; }
    if (Object.keys(fill).length) set(fill);
  }, [exam?.id, f.header]); // eslint-disable-line react-hooks/exhaustive-deps

  const text = (key: keyof PaperFormat, label: string, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label style={labelStyle}>{label}</label>
      <input style={inputStyle} value={(f[key] as string | undefined) ?? ''} placeholder={ph[key as string] ?? ''}
        onChange={e => set({ [key]: e.target.value })} {...extra} />
    </div>
  );

  return (
    <div style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: '10px 12px', marginTop: 12, background: '#FAFAFA' }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 'none', background: 'none', padding: 0,
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
        {open ? <ChevronDown size={15} color="#C8102E" /> : <ChevronRight size={15} color="#C8102E" />}
        <span style={{ fontSize: 13.5, fontWeight: 700, color: '#C8102E' }}>Trình bày đề</span>
        {!open && <span style={{ fontSize: 12.5, color: '#6B7280', marginLeft: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {formatSummary(f, showGroups)}
        </span>}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>Đầu đề</label>
          <select style={inputStyle} value={f.header} onChange={e => set({ header: e.target.value as PaperFormat['header'] })}>
            <option value="none">Không (tên bộ đề + mã đề)</option>
            <option value="vju">Mẫu Trường ĐH Việt Nhật</option>
            <option value="school">Mẫu phổ thông (Sở, Trường)</option>
          </select>
          {keepFormat && f.header !== 'none' && (
            <div style={{ fontSize: 12, color: '#92400E', marginTop: 4 }}>
              Đầu đề được thêm lên trên cùng file Word. File gốc đã có đầu đề thì chọn "Không".
            </div>
          )}
          {f.header !== 'none' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 8 }}>
              {text('org1', 'Dòng 1 (bên trái)')}
              {text('org2', 'Dòng 2 (in đậm)')}
              {f.header === 'vju' && text('org3', 'Dòng 3 (khoa)')}
              {text('title', 'Tên bài thi')}
              {text('term', f.header === 'vju' ? 'Học kỳ, năm học' : 'Năm học')}
              {text('subject', f.header === 'vju' ? 'Học phần' : 'Môn')}
              {f.header === 'vju' && text('subject_code', 'Mã học phần', { placeholder: 'VJU1001' })}
              {text('duration', 'Thời gian (phút)', { inputMode: 'numeric', placeholder: '60' })}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 10 }}>
            <div>
              <label style={labelStyle}>Đánh số câu</label>
              <select style={inputStyle} value={f.label} onChange={e => set({ label: e.target.value as PaperFormat['label'] })}>
                <option value=".">{en ? 'Question 1.' : 'Câu 1.'}</option>
                <option value=":">{en ? 'Question 1:' : 'Câu 1:'}</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Bắt đầu từ câu</label>
              <input type="number" min={1} max={999} style={inputStyle} value={f.start ?? 1}
                onChange={e => set({ start: Math.min(999, Math.max(1, Number(e.target.value) || 1)) })} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
            <label style={checkStyle}>
              <input type="checkbox" checked={en} onChange={e => set({ english: e.target.checked })} />
              Đề tiếng Anh (Question, PART, Exam code)
            </label>
            {showGroups && (
              <label style={checkStyle} title="Bỏ tích: các nhóm câu (<g0>–<g3>) giữ nguyên vị trí, chỉ trộn trong từng nhóm">
                <input type="checkbox" checked={f.shuffle_groups !== false} onChange={e => set({ shuffle_groups: e.target.checked })} />
                Đảo vị trí các nhóm câu
              </label>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 6, lineHeight: 1.5 }}>
            Mỗi phần đều đánh số từ câu {f.start ?? 1}. Đáp án (Word) đánh số giống đề.
          </div>
        </div>
      )}
    </div>
  );
}
