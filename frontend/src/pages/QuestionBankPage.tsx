/**
 * QuestionBankPage.tsx — Ngân hàng câu hỏi (2026-09-28)
 *
 * Bước 1-2 của quy trình trộn đề:
 *   Bên trái: danh mục (thêm / đổi tên / xóa)
 *   Bên phải: câu hỏi trắc nghiệm của danh mục đang chọn (thêm / sửa / xóa),
 *             import file .txt (Aiken — định dạng Moodle export) hoặc .docx
 *             (Word, quy tắc soạn giống YoungMix), export ra 2 định dạng đó.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, FileUp, FolderPlus, Pencil, Pin, Plus, Search, Share2, Trash2, Users, X } from 'lucide-react';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Modal from '../components/modals/Modal';
import PageHeader from '../components/layout/PageHeader';
import { ApiError, questionBankApi } from '../services/apiClient';
import { FileNote, LOSSY, UnansweredPicker } from '../components/common/UnansweredPicker';
import RichText, { hasFormula, plainText } from '../components/common/RichText';
import { clearDrafts, filesSignature, loadPicked, savePicked, useDraft } from '../services/draftStore';
import type { QuestionCategoryOut, QuestionCategoryShareOut, QuestionImportResult, QuestionOption, QuestionOut, QuestionPayload, QuestionType } from '../services/apiClient';

const LETTERS = 'ABCDEFGH';

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', border: '1.5px solid #D1D5DB', borderRadius: 8,
  padding: '8px 10px', fontSize: 14, fontFamily: 'inherit', outline: 'none',
};

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : 'Có lỗi xảy ra';
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Category name modal ──────────────────────────────────────────────────────

function CategoryModal({ initial, onClose, onSave }: {
  initial: QuestionCategoryOut | null;
  onClose: () => void;
  onSave: (name: string, description: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) { setError('Nhập tên danh mục'); return; }
    setSaving(true);
    try { await onSave(name.trim(), description.trim()); }
    catch (e) { setError(errMsg(e)); setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={initial ? 'Sửa danh mục' : 'Thêm danh mục'} width={460}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Hủy</Button>
        <Button loading={saving} onClick={submit}>Lưu</Button>
      </>}>
      <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Tên danh mục</label>
      <input autoFocus style={{ ...inputStyle, margin: '6px 0 14px' }} value={name}
        onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="VD: Tin học đại cương, Chương 1" />
      <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Mô tả (không bắt buộc)</label>
      <textarea style={{ ...inputStyle, marginTop: 6, minHeight: 70, resize: 'vertical' }} value={description}
        onChange={e => setDescription(e.target.value)} />
      {error && <div style={{ color: '#C8102E', fontSize: 13, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}

// ── Question editor modal ────────────────────────────────────────────────────

const QTYPE_SHORT: Record<QuestionType, string> = { mcq: 'Trắc nghiệm', tf: 'Đúng/Sai', short: 'Trả lời ngắn' };
const QTYPE_BADGE: Record<QuestionType, React.CSSProperties> = {
  mcq:   { background: '#EFF6FF', color: '#1D4ED8' },
  tf:    { background: '#FEF3C7', color: '#92400E' },
  short: { background: '#F3E8FF', color: '#7E22CE' },
};

const QTYPE_LABEL: Record<QuestionType, string> = {
  mcq:   'Trắc nghiệm (Phần I-II)',
  tf:    'Đúng/Sai (Phần III)',
  short: 'Trả lời ngắn (Phần IV)',
};

/** Same rule as the backend's normalize_short_answer: what can be bubbled
 *  in Phần IV — optional "-", digits, optional decimal comma, ≤ 4 chars. */
function normalizeShortAnswer(raw: string): string | null {
  const s = raw.replace(/\s+/g, '').replace(/\./g, ',');
  return s.length > 0 && s.length <= 4 && /^-?\d+(,\d+)?$/.test(s) ? s : null;
}

const blankOptions = (n: number, tf = false) =>
  Array.from({ length: n }, () => ({ text: '', fixed: false, ...(tf ? { correct: false } : {}) }));

function QuestionModal({ initial, onClose, onSave }: {
  initial: QuestionOut | null;
  onClose: () => void;
  onSave: (payload: QuestionPayload) => Promise<void>;
}) {
  const [qtype, setQtype] = useState<QuestionType>(initial?.qtype ?? 'mcq');
  const [content, setContent] = useState(initial?.content ?? '');
  // Keep each type's inputs separately so switching type back and forth
  // while writing doesn't wipe what was already typed.
  const [mcqOptions, setMcqOptions] = useState<QuestionOption[]>(
    initial?.qtype === 'mcq' ? initial.options : blankOptions(4));
  const [tfOptions, setTfOptions] = useState<QuestionOption[]>(
    initial?.qtype === 'tf' ? initial.options : blankOptions(4, true));
  const [answer, setAnswer] = useState(initial?.qtype === 'mcq' ? initial.answer : 0);
  const [answerText, setAnswerText] = useState(initial?.answer_text ?? '');
  const [shuffle, setShuffle] = useState(initial?.qtype === 'mcq' ? initial.shuffle_options : true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setMcq = (i: number, patch: Partial<QuestionOption>) =>
    setMcqOptions(prev => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const setTf = (i: number, patch: Partial<QuestionOption>) =>
    setTfOptions(prev => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  const removeOption = (i: number) => {
    setMcqOptions(prev => prev.filter((_, j) => j !== i));
    setAnswer(a => (a === i ? 0 : a > i ? a - 1 : a));
  };

  const submit = async () => {
    setError('');
    if (!content.trim()) { setError('Nhập nội dung câu hỏi'); return; }
    let payload: QuestionPayload;
    if (qtype === 'short') {
      const ans = normalizeShortAnswer(answerText);
      if (!ans) { setError('Đáp án phải tô được trên phiếu: tối đa 4 ký tự gồm dấu -, chữ số, dấu phẩy (vd 75, -1,5, 0,25)'); return; }
      payload = { qtype, content: content.trim(), options: [], answer: 0, answer_text: ans, shuffle_options: false };
    } else if (qtype === 'tf') {
      if (tfOptions.some(o => !o.text.trim())) { setError('Nhập đủ nội dung 4 ý a) b) c) d)'); return; }
      payload = { qtype, content: content.trim(), answer: 0, shuffle_options: false,
        options: tfOptions.map(o => ({ text: o.text.trim(), fixed: false, correct: !!o.correct })) };
    } else {
      if (mcqOptions.some(o => !o.text.trim())) { setError('Không để trống đáp án, hãy xóa đáp án thừa nếu không dùng'); return; }
      payload = { qtype, content: content.trim(), answer, shuffle_options: shuffle,
        options: mcqOptions.map(o => ({ text: o.text.trim(), fixed: o.fixed })) };
    }
    setSaving(true);
    try { await onSave(payload); }
    catch (e) { setError(errMsg(e)); setSaving(false); }
  };

  const typeBtn = (t: QuestionType) => (
    <button key={t} type="button" onClick={() => setQtype(t)}
      style={{ border: `1.5px solid ${qtype === t ? '#C8102E' : '#D1D5DB'}`, background: qtype === t ? '#FEF2F2' : '#fff',
        color: qtype === t ? '#C8102E' : '#374151', borderRadius: 9999, padding: '6px 12px', fontSize: 13,
        fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
      {QTYPE_LABEL[t]}
    </button>
  );

  const iconBtn: React.CSSProperties = { border: 'none', background: 'transparent', padding: 6, display: 'flex', borderRadius: 6 };

  return (
    <Modal open onClose={onClose} title={initial ? 'Sửa câu hỏi' : 'Thêm câu hỏi'} width={660}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Hủy</Button>
        <Button loading={saving} onClick={submit}>Lưu</Button>
      </>}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Loại câu</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {(['mcq', 'tf', 'short'] as const).map(typeBtn)}
      </div>

      <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
        {qtype === 'tf' ? 'Nội dung câu hỏi (phần dẫn chung cho 4 ý)' : 'Nội dung câu hỏi'}
      </label>
      <textarea autoFocus style={{ ...inputStyle, margin: '6px 0 14px', minHeight: 80, resize: 'vertical' }}
        value={content} onChange={e => setContent(e.target.value)} />
      {hasFormula(content) && <FormulaPreview text={content} />}

      {qtype === 'mcq' && <>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
          Đáp án <span style={{ fontWeight: 400, color: '#6B7280' }}>(chọn nút tròn ở đáp án đúng)</span>
          {answer < 0 && <span style={{ fontWeight: 600, color: '#B45309' }}> · chưa chọn đáp án đúng</span>}
        </div>
        {mcqOptions.map((o, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <label title="Đáp án đúng" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontWeight: 700,
              color: answer === i ? '#15803D' : '#374151', minWidth: 42 }}>
              <input type="radio" checked={answer === i} onChange={() => setAnswer(i)} />
              {LETTERS[i]}.
            </label>
            <input style={{ ...inputStyle, flex: '1 1 200px', width: 'auto', minWidth: 0, borderColor: answer === i ? '#86EFAC' : '#D1D5DB' }} value={o.text}
              onChange={e => setMcq(i, { text: e.target.value })} />
            <button type="button" title="Giữ nguyên vị trí khi trộn đáp án (#)" onClick={() => setMcq(i, { fixed: !o.fixed })}
              style={{ ...iconBtn, background: o.fixed ? '#FEF3C7' : 'transparent', color: o.fixed ? '#B45309' : '#9CA3AF', cursor: 'pointer' }}>
              <Pin size={15} />
            </button>
            <button type="button" title="Xóa đáp án" disabled={mcqOptions.length <= 2} onClick={() => removeOption(i)}
              style={{ ...iconBtn, color: mcqOptions.length <= 2 ? '#E5E7EB' : '#9CA3AF', cursor: mcqOptions.length <= 2 ? 'default' : 'pointer' }}>
              <X size={15} />
            </button>
            {hasFormula(o.text) && <div style={{ flexBasis: '100%', paddingLeft: 50 }}><FormulaPreview text={o.text} /></div>}
          </div>
        ))}
        {mcqOptions.length < LETTERS.length && (
          <Button size="sm" variant="ghost" icon={<Plus size={13} />}
            onClick={() => setMcqOptions(prev => [...prev, { text: '', fixed: false }])}>
            Thêm đáp án
          </Button>
        )}
        {mcqOptions.length > 4 && (
          <div style={{ fontSize: 12, color: '#B45309', marginTop: 6 }}>
            ⚠ Phiếu Mẫu 40 câu trắc nghiệm chỉ có A–D, câu có hơn 4 đáp án chỉ dùng được cho đề để in (không chấm bằng phiếu).
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
          <input type="checkbox" checked={shuffle} onChange={e => setShuffle(e.target.checked)} />
          Cho phép trộn thứ tự đáp án khi trộn đề (bỏ chọn cho câu True/False…)
        </label>
      </>}

      {qtype === 'tf' && <>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
          4 ý <span style={{ fontWeight: 400, color: '#6B7280' }}>(chọn Đúng hoặc Sai cho từng ý)</span>
        </div>
        {tfOptions.map((o, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, minWidth: 22 }}>{LETTERS[i].toLowerCase()})</span>
            <input style={{ ...inputStyle, flex: '1 1 260px', width: 'auto' }} value={o.text}
              onChange={e => setTf(i, { text: e.target.value })} />
            {hasFormula(o.text) && <div style={{ flexBasis: '100%', paddingLeft: 30 }}><FormulaPreview text={o.text} /></div>}
            {([true, false] as const).map(v => (
              <button key={String(v)} type="button" onClick={() => setTf(i, { correct: v })}
                style={{ border: `1.5px solid ${!!o.correct === v ? (v ? '#15803D' : '#C8102E') : '#D1D5DB'}`,
                  background: !!o.correct === v ? (v ? '#F0FDF4' : '#FEF2F2') : '#fff',
                  color: !!o.correct === v ? (v ? '#15803D' : '#C8102E') : '#6B7280',
                  borderRadius: 8, padding: '6px 10px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                {v ? 'Đúng' : 'Sai'}
              </button>
            ))}
          </div>
        ))}
      </>}

      {qtype === 'short' && <>
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Đáp án</label>
        <input style={{ ...inputStyle, margin: '6px 0 4px', maxWidth: 160, fontSize: 16, fontWeight: 700, textAlign: 'center' }}
          value={answerText} onChange={e => setAnswerText(e.target.value)} placeholder="vd -1,5" />
        <div style={{ fontSize: 12, color: '#6B7280' }}>
          Tối đa 4 ký tự, đúng như thí sinh tô trên phiếu: dấu <b>-</b>, chữ số, dấu phẩy <b>,</b> (vd 75, -1,5, 0,25, 2025)
          {answerText && normalizeShortAnswer(answerText) && normalizeShortAnswer(answerText) !== answerText.trim() &&
            <>, sẽ lưu là <b>{normalizeShortAnswer(answerText)}</b></>}
        </div>
      </>}

      {error && <div style={{ color: '#C8102E', fontSize: 13, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}

/** How a field with formulas looks: its "[[ct:…]]" codes are the formulas
 *  kept from the Word file (delete a code to remove that formula). */
function FormulaPreview({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 13.5, color: '#1F2937', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8,
      padding: '6px 10px', margin: '-8px 0 12px', lineHeight: 1.8 }}>
      <span style={{ fontSize: 11.5, color: '#6B7280', marginRight: 6 }}>Hiển thị:</span>
      <RichText text={text} />
    </div>
  );
}

// ── Import modal ─────────────────────────────────────────────────────────────

function ImportModal({ category, onClose, onDone }: {
  category: QuestionCategoryOut;
  onClose: () => void;
  onDone: (result: QuestionImportResult) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  // kept while the teacher visits other pages (draftStore); the picks also per file in localStorage
  const draft = `bank.import.${category.id}`;
  const [file, setFile] = useDraft<File | null>(`${draft}.file`, null);
  const [preview, setPreview] = useDraft<QuestionImportResult | null>(`${draft}.preview`, null);
  // đáp án picked here for câu the file doesn't mark: {index in file: option}
  const picksKey = file ? `bank:${category.id}:${filesSignature([file])}` : '';
  const [picked, setPicked] = useState<Record<number, number>>(() => loadPicked(picksKey));
  useEffect(() => { savePicked(picksKey, picked); }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFile(f); setPreview(null); setPicked(loadPicked(`bank:${category.id}:${filesSignature([f])}`)); setError(''); setBusy(true);
    try { setPreview(await questionBankApi.importFile(category.id, f, true)); }
    catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await questionBankApi.importFile(category.id, file, false, picked);
      savePicked(picksKey, {});
      clearDrafts(draft);
      onDone(r);
    }
    catch (e) { setError(errMsg(e)); setBusy(false); }
  };

  // picked answers for câu already in the bank (no answer there yet) are saved too
  const fills = preview ? preview.unanswered_list.filter(u => picked[u.i] != null).length : 0;
  // câu the file has but couldn't be read (a formula/picture note is not one: that câu is still read)
  const unreadable = preview ? preview.warnings.filter(w => !LOSSY.test(w)) : [];

  return (
    <Modal open onClose={onClose} title={`Import câu hỏi vào "${category.name}"`} width={660}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Hủy</Button>
        <Button loading={busy && !!preview} disabled={!preview || (preview.new === 0 && fills === 0)} onClick={confirm}>
          {!preview ? 'Import' : preview.new === 0 && fills > 0 ? `Lưu đáp án ${fills} câu` : `Import ${preview.new} câu`}
        </Button>
      </>}>
      <input ref={fileRef} type="file" accept=".txt,.docx" style={{ display: 'none' }}
        onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <div onClick={() => fileRef.current?.click()}
        style={{ border: '2px dashed #FECACA', background: '#FFF9F9', borderRadius: 12, padding: '22px 16px',
          textAlign: 'center', cursor: 'pointer' }}>
        <FileUp size={22} color="#C8102E" />
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6 }}>{file ? file.name : 'Chọn file .txt hoặc .docx'}</div>
        {busy && !preview && <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Đang đọc file…</div>}
      </div>

      <details style={{ marginTop: 12, fontSize: 13, color: '#374151' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Hướng dẫn định dạng file</summary>
        <div style={{ marginTop: 8, lineHeight: 1.6 }}>
          <b>File .txt (Aiken, xuất từ Moodle)</b> chỉ chứa câu trắc nghiệm:
          <pre style={{ background: '#F9FAFB', padding: 8, borderRadius: 6, margin: '4px 0 10px', fontSize: 12 }}>
{`Which is the fastest cache in a computer?
A) L1
B) L2
C) L3
D) L4
ANSWER: A`}</pre>
          <b>File Word .docx</b> có đủ 3 phần như phiếu trả lời (<a href="/samples/de-mau-3-phan.docx" download style={{ color: '#C8102E', fontWeight: 600 }}>tải file đề mẫu</a>):
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            <li>Dòng tiêu đề <b>PHẦN I-II</b> / <b>PHẦN III</b> / <b>PHẦN IV</b> chia loại câu, như trên phiếu (không có tiêu đề = trắc nghiệm). File đánh số kiểu Bộ GD (Phần I, II, III) vẫn đọc đúng</li>
            <li>Câu hỏi bắt đầu bằng "Câu 1.", "Câu 2."… (hoặc "Question 1.")</li>
            <li><b>Phần I-II, trắc nghiệm:</b> đáp án "A.", "B.", "C.", "D." (nhiều đáp án trên một dòng thì cách nhau bằng Tab). Đáp án đúng: <span style={{ color: '#E00' }}>tô đỏ</span> hoặc <u>gạch chân</u> chữ "A.", hoặc thêm dòng <code>Đáp án: B</code>. "#A." là giữ cố định vị trí đáp án đó khi trộn</li>
            <li><b>Phần III, Đúng/Sai:</b> 4 ý "a)", "b)", "c)", "d)". Các ý <b>Đúng</b>: <span style={{ color: '#E00' }}>tô đỏ</span> hoặc <u>gạch chân</u>, hoặc thêm dòng <code>Đáp án: Đ S Đ S</code></li>
            <li><b>Phần IV, trả lời ngắn:</b> thêm dòng <code>Đáp án: -1,5</code> (tối đa 4 ký tự: dấu -, chữ số, dấu phẩy)</li>
            <li>Dòng &lt;g0&gt;/&lt;g1&gt; trước nhóm câu: không trộn đáp án; &lt;g2&gt;/&lt;g3&gt;: trộn đáp án</li>
            <li>Công thức (MathType, Equation), hình ảnh: được giữ nguyên, hiện trên web và khi xuất Word, trộn đề. Bảng chưa hỗ trợ</li>
          </ul>
        </div>
      </details>

      {preview && (
        <div style={{ marginTop: 14, fontSize: 14 }}>
          {/* total in the file, then what's left out (only when there is any), then what gets added */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Tổng số câu: <b>{preview.found + unreadable.length}</b></span>
            {preview.duplicates > 0 && <span style={{ color: '#6B7280' }}>Câu bị trùng: <b>{preview.duplicates}</b></span>}
            {unreadable.length > 0 && <span style={{ color: '#B45309' }}>Câu không đọc được: <b>{unreadable.length}</b></span>}
            <span style={{ color: '#15803D' }}>Sẽ thêm: <b>{preview.new}</b> câu mới</span>
          </div>
          {preview.new === 0 && preview.duplicates > 0 && (
            <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 6 }}>
              Tất cả câu trong file đã có trong danh mục này.
              {preview.unanswered > 0 && ' Vẫn chọn được đáp án cho các câu còn thiếu bên dưới.'}
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <UnansweredPicker list={preview.unanswered_list} all={preview.mcq_all} picked={picked} setPicked={setPicked} fileName={file?.name}
              hint="Chọn đáp án ngay ở đây, hoặc để trống và chọn sau trong danh mục (lọc Chưa có đáp án)." />
          </div>
          <FileNote groups={[
            { title: 'câu bị trùng, bỏ qua để không nhân đôi', items: preview.duplicate_list ?? [] },
            { title: 'câu không đọc được, bị bỏ qua', items: unreadable },
            { title: 'câu có bảng hoặc hình không đọc được, phần đó bị mất', items: preview.warnings.filter(w => LOSSY.test(w)) },
          ]} />
          {preview.formula_note && (
            <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8 }}>{preview.formula_note}.</div>
          )}
        </div>
      )}
      {error && <div style={{ color: '#C8102E', fontSize: 13, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}

// ── Share modal ──────────────────────────────────────────────────────────────

const PERMISSION_LABEL = { view: 'Chỉ xem', edit: 'Được sửa' } as const;

function ShareModal({ category, onClose }: { category: QuestionCategoryOut; onClose: () => void }) {
  const [shares, setShares] = useState<QuestionCategoryShareOut[] | null>(null);
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<'view' | 'edit'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    questionBankApi.listShares(category.id).then(setShares).catch(e => setError(errMsg(e)));
  }, [category.id]);

  const add = async () => {
    if (!email.trim()) return;
    setBusy(true); setError('');
    try { setShares(await questionBankApi.share(category.id, email.trim(), permission)); setEmail(''); }
    catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); }
  };

  const update = async (s: QuestionCategoryShareOut, p: 'view' | 'edit') => {
    try { setShares(await questionBankApi.share(category.id, s.email, p)); }
    catch (e) { setError(errMsg(e)); }
  };

  const remove = async (s: QuestionCategoryShareOut) => {
    try { await questionBankApi.unshare(category.id, s.id); setShares(prev => prev?.filter(x => x.id !== s.id) ?? null); }
    catch (e) { setError(errMsg(e)); }
  };

  return (
    <Modal open onClose={onClose} title={`Chia sẻ "${category.name}"`} width={560}
      footer={<Button variant="secondary" onClick={onClose}>Đóng</Button>}>
      <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 12, lineHeight: 1.5 }}>
        Người được chia sẻ thấy danh mục này trong ngân hàng của họ. <b>Chỉ xem</b>: xem, export, sao chép về ngân hàng riêng.
        <b> Được sửa</b>: thêm, sửa, xóa, import câu hỏi. Chỉ bạn đổi tên, xóa hoặc chia sẻ được danh mục.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input style={{ ...inputStyle, flex: '1 1 220px', width: 'auto' }} type="email" placeholder="Email giảng viên, vd: gv@vju.ac.vn"
          value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
        <select value={permission} onChange={e => setPermission(e.target.value as 'view' | 'edit')}
          style={{ ...inputStyle, width: 'auto' }}>
          <option value="view">Chỉ xem</option>
          <option value="edit">Được sửa</option>
        </select>
        <Button loading={busy} disabled={!email.trim()} onClick={add}>Chia sẻ</Button>
      </div>
      {error && <div style={{ color: '#C8102E', fontSize: 13, marginTop: 10 }}>{error}</div>}

      <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '18px 0 6px' }}>
        Đang chia sẻ với
      </div>
      {shares === null && !error && <div style={{ fontSize: 13, color: '#9CA3AF' }}>Đang tải…</div>}
      {shares?.length === 0 && <div style={{ fontSize: 13, color: '#6B7280' }}>Chưa chia sẻ với ai.</div>}
      {shares?.map(s => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid #F3F4F6' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name || s.email}</div>
            {s.name && <div style={{ fontSize: 12, color: '#6B7280' }}>{s.email}</div>}
          </div>
          <select value={s.permission} onChange={e => update(s, e.target.value as 'view' | 'edit')}
            style={{ ...inputStyle, width: 'auto', padding: '5px 8px', fontSize: 13 }}>
            <option value="view">Chỉ xem</option>
            <option value="edit">Được sửa</option>
          </select>
          <button type="button" title="Bỏ chia sẻ" onClick={() => remove(s)}
            style={{ border: 'none', background: 'none', color: '#9CA3AF', cursor: 'pointer', padding: 4, display: 'flex' }}>
            <X size={16} />
          </button>
        </div>
      ))}
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function QuestionBankPage() {
  const [categories, setCategories] = useState<QuestionCategoryOut[]>([]);
  // the open danh mục and a half-done import survive visiting other pages
  const [selectedId, setSelectedId] = useDraft<number | null>('bank.selectedId', null);
  const [questions, setQuestions] = useState<QuestionOut[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<QuestionType | 'all' | 'unanswered'>('all');
  const [loading, setLoading] = useState(true);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [categoryModal, setCategoryModal] = useState<{ initial: QuestionCategoryOut | null } | null>(null);
  const [questionModal, setQuestionModal] = useState<{ initial: QuestionOut | null } | null>(null);
  const [importOpen, setImportOpen] = useDraft('bank.importOpen', false);
  const [shareOpen, setShareOpen] = useState(false);

  const selected = categories.find(c => c.id === selectedId) ?? null;
  const canEdit = selected != null && selected.access !== 'view';
  const shownQuestions = typeFilter === 'all' ? questions
    : typeFilter === 'unanswered' ? questions.filter(q => q.qtype === 'mcq' && q.answer < 0)
    : questions.filter(q => q.qtype === typeFilter);

  // Quick pick of the correct option of a question imported without one
  const pickAnswer = async (q: QuestionOut, answer: number) => {
    try {
      const updated = await questionBankApi.setAnswer(q.id, answer);
      setQuestions(prev => prev.map(x => (x.id === q.id ? updated : x)));
      setCategories(prev => prev.map(c => (c.id === q.category_id
        ? { ...c, unanswered: Math.max(0, c.unanswered + (answer < 0 ? 1 : 0) - (q.answer < 0 ? 1 : 0)) } : c)));
    } catch (e) { setError(errMsg(e)); }
  };
  const isOwner = selected?.access === 'owner';

  const loadCategories = useCallback(async () => {
    try {
      const list = await questionBankApi.listCategories();
      setCategories(list);
      setSelectedId(prev => (prev && list.some(c => c.id === prev) ? prev : list[0]?.id ?? null));
      setError('');
    } catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  }, []);

  const loadQuestions = useCallback(async (categoryId: number, q: string) => {
    setLoadingQuestions(true);
    try { setQuestions(await questionBankApi.listQuestions(categoryId, q.trim() || undefined)); setError(''); }
    catch (e) { setError(errMsg(e)); }
    finally { setLoadingQuestions(false); }
  }, []);

  useEffect(() => { loadCategories(); }, [loadCategories]);

  useEffect(() => {
    if (selectedId == null) { setQuestions([]); return; }
    const t = setTimeout(() => loadQuestions(selectedId, search), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [selectedId, search, loadQuestions]);

  const refresh = async () => {
    await loadCategories();
    if (selectedId != null) await loadQuestions(selectedId, search);
  };

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const saveCategory = async (name: string, description: string) => {
    const initial = categoryModal?.initial;
    const saved = initial
      ? await questionBankApi.updateCategory(initial.id, name, description)
      : await questionBankApi.createCategory(name, description);
    setCategoryModal(null);
    await loadCategories();
    setSelectedId(saved.id);
  };

  const deleteCategory = async (c: QuestionCategoryOut) => {
    if (!confirm(`Xóa danh mục "${c.name}" và toàn bộ ${c.question_count} câu hỏi trong đó?`)) return;
    try { await questionBankApi.deleteCategory(c.id); await loadCategories(); }
    catch (e) { setError(errMsg(e)); }
  };

  const saveQuestion = async (payload: QuestionPayload) => {
    if (!selected) return;
    const initial = questionModal?.initial;
    if (initial) await questionBankApi.updateQuestion(initial.id, payload);
    else await questionBankApi.createQuestion(selected.id, payload);
    setQuestionModal(null);
    await refresh();
  };

  const deleteQuestion = async (q: QuestionOut) => {
    if (!confirm('Xóa câu hỏi này?')) return;
    try { await questionBankApi.deleteQuestion(q.id); await refresh(); }
    catch (e) { setError(errMsg(e)); }
  };

  const copyCategory = async () => {
    if (!selected) return;
    try {
      const copy = await questionBankApi.copyCategory(selected.id);
      await loadCategories();
      setSelectedId(copy.id);
      flash(`Đã sao chép ${copy.question_count} câu hỏi về ngân hàng của bạn`);
    } catch (e) { setError(errMsg(e)); }
  };

  const exportFile = async (format: 'txt' | 'docx') => {
    if (!selected) return;
    try { saveBlob(await questionBankApi.exportFile(selected.id, format), `${selected.name}.${format}`); }
    catch (e) { setError(errMsg(e)); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="Ngân hàng câu hỏi"
        subtitle="Câu hỏi theo danh mục (trắc nghiệm, Đúng/Sai, trả lời ngắn). Import, export bằng Word hoặc .txt (Moodle)"
        actions={
          <Button size="sm" icon={<FolderPlus size={13} />} onClick={() => setCategoryModal({ initial: null })}>
            Thêm danh mục
          </Button>
        }
      />

      <div className="qb-body" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* ═══ LEFT: categories ═══ */}
        <div className="qb-categories" style={{ width: 280, flex: '0 0 auto', borderRight: '1px solid #E5E7EB', overflowY: 'auto', padding: '16px 12px', background: '#FAFAFB' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 6px 8px' }}>
            Danh mục
          </div>
          {loading && <div style={{ fontSize: 13, color: '#9CA3AF', padding: 8 }}>Đang tải…</div>}
          {!loading && categories.length === 0 && (
            <div style={{ fontSize: 13, color: '#6B7280', padding: 8, lineHeight: 1.5 }}>
              Chưa có danh mục nào. Bấm <b>Thêm danh mục</b> để bắt đầu.
            </div>
          )}
          {categories.map(c => {
            const active = c.id === selectedId;
            return (
              <div key={c.id} onClick={() => { setSelectedId(c.id); setSearch(''); }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 10px', borderRadius: 10, cursor: 'pointer',
                  marginBottom: 4, background: active ? '#FEECEC' : 'transparent', border: `1px solid ${active ? '#FECACA' : 'transparent'}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: active ? '#C8102E' : '#1F2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.name}
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280' }}>{c.question_count} câu hỏi</div>
                  {c.access !== 'owner' && (
                    <div style={{ fontSize: 11.5, color: '#1D4ED8', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                      <Users size={11} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.owner_name} · {PERMISSION_LABEL[c.access]}</span>
                    </div>
                  )}
                </div>
                {c.access === 'owner' && <>
                <button type="button" title="Sửa" onClick={e => { e.stopPropagation(); setCategoryModal({ initial: c }); }}
                  style={{ border: 'none', background: 'none', color: '#9CA3AF', cursor: 'pointer', padding: 4, display: 'flex' }}>
                  <Pencil size={14} />
                </button>
                <button type="button" title="Xóa" onClick={e => { e.stopPropagation(); deleteCategory(c); }}
                  style={{ border: 'none', background: 'none', color: '#9CA3AF', cursor: 'pointer', padding: 4, display: 'flex' }}>
                  <Trash2 size={14} />
                </button>
                </>}
              </div>
            );
          })}
        </div>

        {/* ═══ RIGHT: questions ═══ */}
        <div className="qb-questions" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '18px 24px' }}>
          {error && (
            <Card style={{ padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: '#C8102E' }}>⚠ {error}</div>
            </Card>
          )}
          {notice && (
            <Card style={{ padding: '10px 14px', background: '#F0FDF4', border: '1px solid #BBF7D0', marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: '#15803D' }}>✓ {notice}</div>
            </Card>
          )}

          {selected ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <div style={{ fontSize: 17, fontWeight: 700, color: '#1F2937' }}>{selected.name}</div>
                  {selected.description && <div style={{ fontSize: 13, color: '#6B7280' }}>{selected.description}</div>}
                  {!isOwner && (
                    <div style={{ fontSize: 12.5, color: '#1D4ED8', marginTop: 2 }}>
                      Được chia sẻ bởi {selected.owner_name} · {PERMISSION_LABEL[selected.access as 'view' | 'edit']}
                    </div>
                  )}
                </div>
                {canEdit && <Button size="sm" icon={<Plus size={13} />} onClick={() => setQuestionModal({ initial: null })}>Thêm câu hỏi</Button>}
                {canEdit && <Button size="sm" variant="outline" icon={<FileUp size={13} />} onClick={() => setImportOpen(true)}>Import</Button>}
                {isOwner && <Button size="sm" variant="secondary" icon={<Share2 size={13} />} onClick={() => setShareOpen(true)}>Chia sẻ</Button>}
                {!isOwner && <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={copyCategory}>Sao chép về ngân hàng của tôi</Button>}
                <Button size="sm" variant="secondary" icon={<Download size={13} />} disabled={!selected.type_counts?.mcq}
                  title="File .txt (Moodle) chỉ chứa câu trắc nghiệm. Dùng Export Word để có đủ 3 phần" onClick={() => exportFile('txt')}>Export .txt</Button>
                <Button size="sm" variant="secondary" icon={<Download size={13} />} disabled={selected.question_count === 0} onClick={() => exportFile('docx')}>Export Word</Button>
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 420 }}>
                  <Search size={15} color="#9CA3AF" style={{ position: 'absolute', left: 10, top: 11 }} />
                  <input style={{ ...inputStyle, paddingLeft: 32 }} placeholder="Tìm câu hỏi…" value={search} onChange={e => setSearch(e.target.value)} />
                </div>
                {/* Filter by kind — counts are for the whole category */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['all', 'mcq', 'tf', 'short'] as const).map(t => {
                    const count = t === 'all' ? selected.question_count : selected.type_counts?.[t] ?? 0;
                    const active = typeFilter === t;
                    return (
                      <button key={t} type="button" onClick={() => setTypeFilter(t)}
                        style={{ border: `1.5px solid ${active ? '#C8102E' : '#E5E7EB'}`, background: active ? '#FEF2F2' : '#fff',
                          color: active ? '#C8102E' : '#4B5563', borderRadius: 9999, padding: '5px 11px', fontSize: 12.5,
                          fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                        {t === 'all' ? 'Tất cả' : QTYPE_SHORT[t]} ({count})
                      </button>
                    );
                  })}
                  {selected.unanswered > 0 && (
                    <button type="button" onClick={() => setTypeFilter('unanswered')}
                      style={{ border: `1.5px solid ${typeFilter === 'unanswered' ? '#D97706' : '#FDE68A'}`,
                        background: typeFilter === 'unanswered' ? '#FEF3C7' : '#FFFBEB', color: '#B45309', borderRadius: 9999,
                        padding: '5px 11px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                      Chưa có đáp án ({selected.unanswered})
                    </button>
                  )}
                </div>
              </div>

              {loadingQuestions && questions.length === 0 && <div style={{ fontSize: 13, color: '#9CA3AF' }}>Đang tải…</div>}
              {!loadingQuestions && shownQuestions.length === 0 && (
                <Card style={{ padding: '32px 20px', textAlign: 'center', fontSize: 14, color: '#6B7280' }}>
                  {typeFilter === 'unanswered' ? 'Mọi câu đã có đáp án.'
                    : search || typeFilter !== 'all' ? 'Không có câu hỏi nào khớp.' : 'Danh mục chưa có câu hỏi. Thêm thủ công hoặc Import từ file.'}
                </Card>
              )}

              {shownQuestions.map((q, idx) => (
                <Card key={q.id} style={{ padding: '14px 16px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#C8102E', minWidth: 30 }}>{idx + 1}.</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '1px 7px', marginBottom: 6,
                        ...QTYPE_BADGE[q.qtype] }}>{QTYPE_SHORT[q.qtype]}</span>
                      {q.qtype === 'mcq' && q.answer < 0 && (
                        <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '1px 7px',
                          marginBottom: 6, marginLeft: 6, background: '#FEF3C7', color: '#B45309' }}>Chưa có đáp án</span>
                      )}
                      <div style={{ fontSize: 14, color: '#1F2937', whiteSpace: 'pre-wrap', marginBottom: 8 }}><RichText text={q.content} /></div>
                      {q.qtype === 'mcq' && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px 16px' }}>
                          {q.options.map((o, i) => (
                            <div key={i} style={{ fontSize: 13, color: i === q.answer ? '#15803D' : '#4B5563', fontWeight: i === q.answer ? 700 : 400 }}>
                              {o.fixed ? '#' : ''}{LETTERS[i]}. <RichText text={o.text} />{i === q.answer ? ' ✓' : ''}
                            </div>
                          ))}
                        </div>
                      )}
                      {q.qtype === 'mcq' && q.answer < 0 && canEdit && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12.5, color: '#B45309', fontWeight: 600 }}>Chọn đáp án đúng:</span>
                          {q.options.map((o, i) => (
                            <button key={i} type="button" title={plainText(o.text)} onClick={() => pickAnswer(q, i)}
                              style={{ width: 32, height: 28, borderRadius: 7, border: '1.5px solid #FDE68A', background: '#fff',
                                color: '#374151', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                              {LETTERS[i]}
                            </button>
                          ))}
                        </div>
                      )}
                      {q.qtype === 'tf' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {q.options.map((o, i) => (
                            <div key={i} style={{ fontSize: 13, color: '#4B5563', display: 'flex', gap: 8 }}>
                              <span style={{ flex: 1 }}>{LETTERS[i].toLowerCase()}) <RichText text={o.text} /></span>
                              <b style={{ color: o.correct ? '#15803D' : '#C8102E', whiteSpace: 'nowrap' }}>{o.correct ? 'Đúng' : 'Sai'}</b>
                            </div>
                          ))}
                        </div>
                      )}
                      {q.qtype === 'short' && (
                        <div style={{ fontSize: 13, color: '#15803D', fontWeight: 700 }}>Đáp án: {q.answer_text}</div>
                      )}
                      {q.qtype === 'mcq' && (!q.shuffle_options || q.options.length > 4) && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          {!q.shuffle_options && <span style={{ fontSize: 11, background: '#F3F4F6', color: '#4B5563', borderRadius: 6, padding: '2px 7px' }}>Không trộn đáp án</span>}
                          {q.options.length > 4 && <span style={{ fontSize: 11, background: '#FEF3C7', color: '#92400E', borderRadius: 6, padding: '2px 7px' }}>{q.options.length} đáp án, chỉ dùng cho đề để in</span>}
                        </div>
                      )}
                    </div>
                    {canEdit && <>
                    <button type="button" title="Sửa" onClick={() => setQuestionModal({ initial: q })}
                      style={{ border: 'none', background: 'none', color: '#6B7280', cursor: 'pointer', padding: 4, display: 'flex' }}>
                      <Pencil size={15} />
                    </button>
                    <button type="button" title="Xóa" onClick={() => deleteQuestion(q)}
                      style={{ border: 'none', background: 'none', color: '#6B7280', cursor: 'pointer', padding: 4, display: 'flex' }}>
                      <Trash2 size={15} />
                    </button>
                    </>}
                  </div>
                </Card>
              ))}
            </>
          ) : !loading && (
            <Card style={{ padding: '40px 20px', textAlign: 'center', fontSize: 14, color: '#6B7280' }}>
              Tạo một danh mục ở bên trái để bắt đầu thêm câu hỏi.
            </Card>
          )}
        </div>
      </div>

      {categoryModal && <CategoryModal initial={categoryModal.initial} onClose={() => setCategoryModal(null)} onSave={saveCategory} />}
      {questionModal && <QuestionModal initial={questionModal.initial} onClose={() => setQuestionModal(null)} onSave={saveQuestion} />}
      {shareOpen && selected && <ShareModal category={selected} onClose={() => setShareOpen(false)} />}
      {importOpen && selected && (
        <ImportModal category={selected} onClose={() => { clearDrafts(`bank.import.${selected.id}`); setImportOpen(false); }}
          onDone={async r => {
            setImportOpen(false);
            flash(`Đã import ${r.new} câu hỏi${r.duplicates ? ` (bỏ qua ${r.duplicates} câu trùng)` : ''}`
              + (r.answered ? `, lưu đáp án cho ${r.answered} câu đã có` : '')
              + (r.unanswered ? `. ${r.unanswered} câu chưa có đáp án: bấm "Chưa có đáp án" để chọn.` : ''));
            await refresh();
          }} />
      )}
    </div>
  );
}
