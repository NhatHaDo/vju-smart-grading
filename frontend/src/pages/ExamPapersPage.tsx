/**
 * ExamPapersPage.tsx — Trộn đề (2026-09-29)
 *
 * Bước 4-5 của quy trình:
 *   - Trộn nhanh 1 file Word (chức năng như YoungMix, giao diện theo app):
 *     thả file → tải .zip các mã đề; hướng dẫn soạn đề, nhóm <g0>–<g3>, file mẫu.
 *   - Tạo bộ đề: trộn từ ngân hàng câu hỏi (chọn danh mục + số câu từng phần)
 *     hoặc trộn trực tiếp 1 file đề (.docx 3 phần / .txt Moodle); chọn số mã
 *     đề, mã đề bắt đầu, trộn câu hỏi / trộn đáp án.
 *   - Xuất Word từng mã đề, file đáp án, hoặc tải tất cả (.zip) để in.
 *   - Gắn bộ đề vào kỳ thi, chọn mã đề nào dùng trong kỳ thi → khi chấm, đáp
 *     án từng mã đề tự điền (AnswerKeyPage / Chấm nhanh).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Dices, Download, FileText, FileUp, Plus, Shuffle, Trash2, X } from 'lucide-react';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Modal from '../components/modals/Modal';
import PageHeader from '../components/layout/PageHeader';
import { ApiError, examPapersApi, examsApi, questionBankApi } from '../services/apiClient';
import type { AnswerSheetSpec, ExamPaperOut, MixOptions, ParsedFileInfo, PartCounts, QuestionCategoryOut, QuestionType } from '../services/apiClient';
import type { ExamOut } from '../types/exam';
import { FileNote, LOSSY, UnansweredPicker } from '../components/common/UnansweredPicker';
import { filesSignature, loadPicked, savePicked, useDraft } from '../services/draftStore';
import { saveAs } from 'file-saver';
import { serverDate } from '../utils/serverDate';

const PARTS: { key: QuestionType; label: string }[] = [
  { key: 'mcq',   label: 'Phần I-II: Trắc nghiệm' },   // named as on the VJU sheet
  { key: 'tf',    label: 'Phần III: Đúng/Sai' },
  { key: 'short', label: 'Phần IV: Trả lời ngắn' },
];

// ── Answer sheets (2026-10-05) ───────────────────────────────────────────────
// "t muốn dropdown cái này … cái này có nhiều mẫu phiếu lắm mà": every sheet in
// the system can be picked; how many câu each part may have, how many đáp án
// a trắc nghiệm câu may have and how many digits the mã đề has all come from
// the sheet (GET /exam-papers/sheets). Until the list arrives: Mẫu 40.

const MAU40_SPEC: AnswerSheetSpec = {
  id: 0, name: 'Phiếu Mẫu 40 câu (VJU)', limits: { mcq: 40, tf: 8, short: 6 }, mcq_options: 4, code_digits: 4,
};
let sheetsCache: AnswerSheetSpec[] | null = null;

function useSheets(): AnswerSheetSpec[] {
  const [list, setList] = useState<AnswerSheetSpec[]>(sheetsCache ?? []);
  useEffect(() => {
    let alive = true;
    examPapersApi.sheets()
      .then(r => { sheetsCache = r; if (alive) setList(r); })
      .catch(() => { /* keep Mẫu 40 */ });
    return () => { alive = false; };
  }, []);
  return list;
}

/** The chosen sheet's spec (the first one when the choice is gone). */
function specOf(sheets: AnswerSheetSpec[], id: number | null): AnswerSheetSpec {
  return sheets.find(s => s.id === id) ?? sheets[0] ?? MAU40_SPEC;
}

const LETTERS = 'ABCDEFGH';

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', border: '1.5px solid #D1D5DB', borderRadius: 8,
  padding: '8px 10px', fontSize: 14, fontFamily: 'inherit', outline: 'none', background: '#fff',
};
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: '#374151' };

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

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'de-thi';
}

// ── Mã đề: "101" / "A" / "Đề 1" counting up, or a list "A, B, C, D" ────────
// Mirrors exam_mixer.version_codes on the server (which has the last word).

function versionCodes(spec: string, n: number, forSheet: boolean,
                      codeDigits: number | null = 4): { codes: string[]; error?: string } {
  const s = spec.trim();
  if (!s) return { codes: [], error: 'Nhập mã đề (vd 101, A, Đề 1, hoặc danh sách A, B, C, D)' };
  let codes: string[];
  if (/[,;]/.test(s)) {
    codes = s.split(/[,;]/).map(c => c.trim()).filter(Boolean);
    if (codes.length < 1 || codes.length > 24) return { codes, error: 'Số mã đề phải từ 1 đến 24' };
  } else {
    if (n < 1 || n > 24) return { codes: [], error: 'Số mã đề phải từ 1 đến 24' };
    const num = s.match(/^(.*?)(\d+)$/);
    const letter = s.match(/^(.*?)([A-Za-z])$/);
    if (num) {
      codes = Array.from({ length: n }, (_, i) => num[1] + String(Number(num[2]) + i).padStart(num[2].length, '0'));
    } else if (letter) {
      const base = letter[2] === letter[2].toUpperCase() ? 65 : 97;
      if (letter[2].charCodeAt(0) - base + n > 26) return { codes: [], error: `Không đủ chữ cái để tạo ${n} mã đề từ "${s}"` };
      codes = Array.from({ length: n }, (_, i) => letter[1] + String.fromCharCode(letter[2].charCodeAt(0) + i));
    } else {
      return { codes: [], error: 'Mã đề phải kết thúc bằng số hoặc chữ cái để tự tăng (vd 101, A, Đề 1), hoặc nhập danh sách cách nhau bằng dấu phẩy' };
    }
  }
  const bad = codes.find(c => c.length > 10 || !/^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*$/u.test(c));
  if (bad) return { codes, error: `Mã đề "${bad}" không hợp lệ (tối đa 10 ký tự, chỉ gồm chữ, số, dấu cách, - _ .)` };
  if (new Set(codes.map(c => c.toLowerCase())).size !== codes.length) return { codes, error: 'Các mã đề bị trùng nhau' };
  if (forSheet) {
    if (codeDigits == null) {      // the sheet has no Mã đề box
      return codes.length > 1
        ? { codes, error: 'Phiếu này không có ô Mã đề nên chỉ trộn được 1 mã đề. Chọn "Chỉ in đề" để in nhiều mã đề' }
        : { codes };
    }
    if (!codes.every(c => /^\d+$/.test(c))) {
      return { codes, error: 'Phiếu chỉ tô được mã đề là số. Chọn "Chỉ in đề" để dùng mã đề chữ' };
    }
    const width = Math.min(Math.max(codes[0].length, Math.min(3, codeDigits)), codeDigits);
    if (codes.some(c => c.length > width)) {
      return { codes, error: `Mã đề vượt quá số chữ số trên phiếu (tối đa ${codeDigits} chữ số), hãy chọn mã đề nhỏ hơn` };
    }
  }
  return { codes };
}

/** n distinct 3-digit mã đề in increasing order, e.g. "132, 209, 357, 485". */
function randomCodes(n: number): string {
  const set = new Set<number>();
  while (set.size < Math.min(n, 24)) set.add(100 + Math.floor(Math.random() * 900));
  return [...set].sort((a, b) => a - b).join(', ');
}

/** "Số mã đề" + "Mã đề" (two grid cells). Mã đề: one code counting up
 *  ("101", "A", "Đề 1"), the teacher's own list ("132, 209, 357"), or a
 *  random list from the dice button. */
function VersionCodeFields({ numVersions, setNumVersions, spec, setSpec, forSheet, codeDigits }: {
  numVersions: number; setNumVersions: (n: number) => void;
  spec: string; setSpec: (s: string) => void; forSheet: boolean; codeDigits: number | null;
}) {
  const [lastRandom, setLastRandom] = useState('');
  const isList = /[,;]/.test(spec);
  const isRandom = isList && spec === lastRandom;
  const { codes, error } = versionCodes(spec, numVersions, forSheet, codeDigits);
  const roll = (n: number) => { const r = randomCodes(n); setLastRandom(r); setSpec(r); };
  return (
    <>
      <div>
        <label style={labelStyle}>Số mã đề</label>
        <input type="number" min={1} max={24} value={isList ? codes.length : numVersions} disabled={isList && !isRandom}
          title={isList && !isRandom ? 'Số mã đề đang theo danh sách mã đề bên cạnh' : undefined}
          onChange={e => {
            const n = Math.min(24, Math.max(1, Number(e.target.value) || 1));
            setNumVersions(n);
            if (isRandom) roll(n);
          }} style={{ ...inputStyle, marginTop: 6 }} />
      </div>
      <div style={{ position: 'relative' }}>
        <label style={labelStyle}>Mã đề</label>
        <button type="button" onClick={() => roll(isList ? codes.length || numVersions : numVersions)}
          title="Tạo mã đề ngẫu nhiên 3 chữ số"
          style={{ position: 'absolute', top: 3, right: 0, border: 'none', background: 'none', padding: 0, color: '#C8102E',
            fontWeight: 700, fontSize: 12, lineHeight: 1, cursor: 'pointer', fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 4 }}>
          <Dices size={13} /> Ngẫu nhiên
        </button>
        <input value={spec} onChange={e => setSpec(e.target.value)} style={{ ...inputStyle, marginTop: 6 }}
          title="Nhập 1 mã để tự tăng (101 → 102, 103…) hoặc tự gõ danh sách mã đề, cách nhau dấu phẩy"
          placeholder={forSheet ? '101 hoặc 132, 209, 357' : '101, A, Đề 1 hoặc 132, 209, 357'} />
        <div style={{ fontSize: 11.5, color: error ? '#C8102E' : '#9CA3AF', marginTop: 2, lineHeight: 1.4 }}>
          {error ?? (isList
            ? `${codes.length} mã đề`
            : `→ ${codes.length > 4 ? `${codes.slice(0, 3).join(', ')} … ${codes[codes.length - 1]}` : codes.join(', ')}`)}
        </div>
      </div>
    </>
  );
}

// ── Mix from a file: read it first, pick how many per part ───────────────────

/** Reads the chosen file on the server; defaults each part to as many
 *  questions as the sheet holds (a 131-câu Moodle file → 40 random). */
/** What the server read from a set of files, so coming back to the page doesn't re-read them. */
const parsedCache = new Map<string, ParsedFileInfo>();

/** `draftKey`: keep the counts across page switches (useDraft). Picked
 *  answers are always kept per file (draftStore: savePicked). */
function useFileCounts(files: File[], forSheet: boolean, sheet: AnswerSheetSpec, draftKey?: string) {
  const filesKey = filesSignature(files);
  const picksKey = filesKey && `mix:${filesKey}`;
  const [raw, setRaw] = useState<ParsedFileInfo | null>(() => parsedCache.get(filesKey) ?? null);
  const [counts, setCounts] = useDraft<PartCounts>(draftKey && `${draftKey}.counts`, { mcq: 0, tf: 0, short: 0 });
  // what `counts` were last defaulted for: the same → keep the teacher's numbers
  const [countsBasis, setCountsBasis] = useDraft(draftKey && `${draftKey}.countsBasis`, '');
  // đáp án picked on the page for questions the file doesn't mark: {question i: option}
  const [picked, setPicked] = useState<Record<number, number>>(() => loadPicked(picksKey));
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState('');

  const firstRun = useRef(true);
  useEffect(() => {
    setReadError('');
    if (!firstRun.current) setPicked(loadPicked(picksKey));
    firstRun.current = false;
    if (files.length === 0) { setRaw(null); return; }
    const cached = parsedCache.get(filesKey);
    if (cached) { setRaw(cached); return; }
    setRaw(null);
    let alive = true;
    setReading(true);
    examPapersApi.parseFile(files)
      .then(r => { parsedCache.set(filesKey, r); if (alive) setRaw(r); })
      .catch(e => { if (alive) setReadError(errMsg(e)); })
      .finally(() => { if (alive) setReading(false); });
    return () => { alive = false; };
  }, [filesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // picks survive a reload: choosing the same file again brings them back
  useEffect(() => { savePicked(picksKey, picked); }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trắc nghiệm usable on the sheet: an answer (in the file or picked here)
  // and no more options than the sheet has bubbles
  const maxOpts = sheet.mcq_options;
  const mcqOnSheet = raw ? raw.mcq_all.filter(r => r.options.length <= maxOpts && (r.answer >= 0 || picked[r.i] != null)).length : 0;
  const info: ParsedFileInfo | null = raw && {
    ...raw, available: { ...raw.available, mcq: mcqOnSheet }, limits: sheet.limits,
    too_many_options: raw.mcq_all.filter(r => r.options.length > maxOpts).length,
    too_many_options_list: raw.mcq_all.filter(r => r.options.length > maxOpts).map(r =>
      `${r.where || 'Câu'} "${r.content.slice(0, 60)}${r.content.length > 60 ? '…' : ''}": ${r.options.length} đáp án`),
  };

  // Default: as many as the sheet holds, or every question for a đề chỉ để in
  const availKey = info ? `${info.available.mcq}/${info.available.tf}/${info.available.short}` : '';
  const limitsKey = `${sheet.limits.mcq}/${sheet.limits.tf}/${sheet.limits.short}`;
  useEffect(() => {
    if (!info) return;
    const basis = `${filesKey}#${availKey}#${forSheet}#${limitsKey}`;
    if (basis === countsBasis) return;          // back on the page: keep what was typed
    setCountsBasis(basis);
    const pick = (qt: QuestionType) => forSheet ? Math.min(info.available[qt], info.limits[qt]) : info.available_all[qt];
    setCounts({ mcq: pick('mcq'), tf: pick('tf'), short: pick('short') });
  }, [raw, availKey, forSheet, limitsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxOf = (p: typeof PARTS[number]) =>
    !info ? 0 : forSheet ? Math.min(sheet.limits[p.key], info.available[p.key]) : info.available_all[p.key];
  const tooMany = !!info && PARTS.some(p => counts[p.key] > maxOf(p));
  const empty = !!info && counts.mcq + counts.tf + counts.short === 0;
  const fileName = files.length === 1 ? files[0].name : files.length ? `${files.length} file` : '';
  return { info, counts, setCounts, picked, setPicked, reading, readError, tooMany, empty, forSheet, sheet, maxOf, fileName };
}

/** Trắc nghiệm questions the file doesn't mark an answer for: pick A/B/C/D
 *  here instead of editing the Word file. */
function FilePicker({ fc }: { fc: ReturnType<typeof useFileCounts> }) {
  const { info, picked, setPicked, forSheet } = fc;
  if (!info) return null;
  return (
    <UnansweredPicker list={info.unanswered} all={info.mcq_all} picked={picked} setPicked={setPicked} fileName={fc.fileName}
      hint={forSheet ? 'Chọn đáp án ngay ở đây để dùng các câu này; câu chưa chọn sẽ không được dùng.'
                     : 'Câu chưa chọn vẫn được trộn, trong file đáp án ghi dấu ?.'} />
  );
}

/** Short name of a part: "Phần I-II" is sheet wording, a đề chỉ để in just has "Trắc nghiệm". */
function partName(p: typeof PARTS[number], forSheet: boolean) {
  const [part, kind] = p.label.split(': ');
  return forSheet ? `${part} (${p.key === 'tf' ? kind : kind.toLowerCase()})` : kind;
}

/** What the chosen sheet holds, in words: "40 trắc nghiệm (A–D), 8 Đúng/Sai, 6 trả lời ngắn, mã đề 3 chữ số". */
function sheetSummary(sp: AnswerSheetSpec): string {
  const parts = [
    sp.limits.mcq ? `${sp.limits.mcq} trắc nghiệm (A–${LETTERS[sp.mcq_options - 1] ?? 'D'})` : '',
    sp.limits.tf ? `${sp.limits.tf} Đúng/Sai` : '',
    sp.limits.short ? `${sp.limits.short} trả lời ngắn` : '',
  ].filter(Boolean);
  return `Tối đa ${parts.join(', ')}, ${sp.code_digits == null ? 'không có ô mã đề (1 mã đề)' : `mã đề tối đa ${sp.code_digits} chữ số`}`;
}

/** Which sheet the bộ đề is graded on, or chỉ in đề.
 *  2026-10-05 (anh Tú): "cái này a chỉ chọn đc mỗi mẫu phiếu 40 câu thôi à";
 *  then "t muốn dropdown cái này … có nhiều mẫu phiếu lắm mà" — one dropdown
 *  with every sheet in the system (shared ones first, then the teacher's own). */
function SheetSelect({ forSheet, onForSheet, sheet, onSheet, sheets }: {
  forSheet: boolean; onForSheet: (v: boolean) => void;
  sheet: AnswerSheetSpec; onSheet: (id: number) => void; sheets: AnswerSheetSpec[];
}) {
  const list = sheets.length ? sheets : [MAU40_SPEC];
  return (
    <div style={{ margin: '0 0 14px' }}>
      <label style={labelStyle}>Phiếu trả lời</label>
      <select value={forSheet ? String(sheet.id) : 'print'}
        onChange={e => {
          if (e.target.value === 'print') { onForSheet(false); return; }
          onForSheet(true);
          onSheet(Number(e.target.value));
        }}
        style={{ ...inputStyle, marginTop: 6, fontWeight: 600, color: '#1F2937' }}>
        {list.map(sp => <option key={sp.id} value={String(sp.id)}>Chấm bằng {sp.name}</option>)}
        <option value="print">Chỉ in đề (không chấm bằng phiếu)</option>
      </select>
      {!forSheet && (
        <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 5 }}>
          Không giới hạn số câu, tối đa 8 đáp án mỗi câu. Chấm tay hoặc dùng phiếu khác.
        </div>
      )}
    </div>
  );
}

/** Adds the .docx/.txt files of a pick or drop, skipping ones already chosen. */
function addFiles(prev: File[], list: FileList | File[] | null | undefined): { files: File[]; error: string } {
  const picked = Array.from(list ?? []);
  const ok = picked.filter(f => /\.(docx|txt)$/i.test(f.name));
  const seen = new Set(prev.map(f => `${f.name}/${f.size}`));
  const files = [...prev, ...ok.filter(f => !seen.has(`${f.name}/${f.size}`))];
  return { files, error: ok.length < picked.length ? 'Chỉ nhận file Word .docx hoặc .txt' : '' };
}

/** The chosen file(s): each removable, plus "Thêm file" to pool more. */
function FileList({ files, onRemove, onAdd }: { files: File[]; onRemove: (i: number) => void; onAdd: () => void }) {
  return (
    <div style={{ border: '1.5px solid #FECACA', background: '#FFF9F9', borderRadius: 10, padding: '6px 12px', marginBottom: 14 }}>
      {files.map((f, i) => (
        <div key={`${f.name}/${f.size}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0',
          borderTop: i ? '1px solid #FEE2E2' : 'none' }}>
          <FileText size={17} color="#C8102E" style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          <button type="button" title="Bỏ file này" onClick={() => onRemove(i)}
            style={{ border: 'none', background: 'none', color: '#9CA3AF', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <X size={16} />
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0 2px', borderTop: '1px solid #FEE2E2' }}>
        <button type="button" onClick={onAdd}
          style={{ border: 'none', background: 'none', padding: 0, color: '#C8102E', fontWeight: 700, fontSize: 12.5,
            cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Plus size={14} /> Thêm file
        </button>
        {files.length > 1 && (
          <span style={{ fontSize: 12, color: '#9CA3AF' }}>Câu hỏi của {files.length} file được gộp thành một đề</span>
        )}
      </div>
    </div>
  );
}

/** "Số câu" inputs, one per kind of question the source actually has
 *  (a trắc nghiệm-only bank shows just one "Số câu" box). `available` = all
 *  questions there; `limitAvailable` = those usable on the sheet. */
function PartCountInputs({ forSheet, limits, counts, setCounts, available, limitAvailable }: {
  forSheet: boolean;
  limits: PartCounts;
  counts: PartCounts;
  setCounts: React.Dispatch<React.SetStateAction<PartCounts>>;
  available: PartCounts;
  limitAvailable: PartCounts;
}) {
  // Chấm bằng phiếu: every part the sheet has (Phần I-II / III / IV), even
  // an empty one — that's how the sheet is laid out. Chỉ in đề: only the
  // kinds the source has, and a single "Số câu" box when there's one kind.
  const parts = forSheet ? PARTS.filter(p => limits[p.key] > 0) : PARTS.filter(p => available[p.key] > 0);
  if (parts.length === 0) return <div style={{ fontSize: 13, color: '#9CA3AF' }}>Chưa có câu hỏi nào.</div>;
  const single = !forSheet && parts.length === 1;
  return (
    <div style={single ? {} : { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
      {parts.map(p => {
        const avail = forSheet ? limitAvailable[p.key] : available[p.key];
        const limit = limits[p.key];
        const max = forSheet ? Math.min(limit, avail) : avail;
        const over = counts[p.key] > max;
        return (
          <div key={p.key}>
            <label style={labelStyle}>{single ? 'Số câu' : partName(p, forSheet)}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <input type="number" min={0} max={max} value={counts[p.key]} disabled={max === 0}
                onChange={e => setCounts(prev => ({ ...prev, [p.key]: Math.max(0, Number(e.target.value) || 0) }))}
                style={{ ...inputStyle, width: 90, borderColor: over ? '#FCA5A5' : '#D1D5DB',
                  background: max === 0 ? '#F9FAFB' : '#fff' }} />
              <span style={{ fontSize: 13, color: over ? '#C8102E' : '#6B7280', whiteSpace: 'nowrap' }}>/ {avail} câu</span>
            </div>
            {over && <div style={{ fontSize: 11.5, color: '#C8102E', marginTop: 3 }}>tối đa {max}</div>}
          </div>
        );
      })}
    </div>
  );
}

function FileCountsPicker({ fc }: { fc: ReturnType<typeof useFileCounts> }) {
  const { info, counts, setCounts, reading, readError, forSheet, sheet } = fc;
  if (reading) return <div style={{ fontSize: 13, color: '#6B7280', margin: '0 0 14px' }}>Đang đọc file…</div>;
  if (readError) return <div style={{ fontSize: 13, color: '#C8102E', margin: '0 0 14px' }}>⚠ {readError}</div>;
  if (!info) return null;
  const tooManyOpts = forSheet ? info.too_many_options_list : [];
  // câu the file has but couldn't be read (a formula/picture note is not one: that câu is still used)
  const unreadable = info.warnings.filter(w => !LOSSY.test(w));
  const duplicates = info.duplicate_list ?? [];
  const read = info.available_all.mcq + info.available_all.tf + info.available_all.short;
  return (
    <div style={{ margin: '0 0 14px' }}>
      {/* like the ngân hàng's import: total in the file, then what's left out (only when there is any) */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 14, margin: '0 0 10px' }}>
        <span>Tổng số câu: <b>{read + duplicates.length + unreadable.length}</b></span>
        {duplicates.length > 0 && <span style={{ color: '#6B7280' }}>Câu bị trùng: <b>{duplicates.length}</b></span>}
        {unreadable.length > 0 && <span style={{ color: '#B45309' }}>Câu không đọc được: <b>{unreadable.length}</b></span>}
        {tooManyOpts.length > 0 && <span style={{ color: '#B45309' }}>Câu có hơn {sheet.mcq_options} đáp án: <b>{tooManyOpts.length}</b></span>}
      </div>
      <FilePicker fc={fc} />
      <PartCountInputs forSheet={forSheet} limits={sheet.limits} counts={counts} setCounts={setCounts}
        available={info.available_all} limitAvailable={info.available} />
      <FileNote groups={[
        { title: 'câu bị trùng, bỏ qua để không ra 2 lần trong một mã đề', items: duplicates },
        { title: 'câu không đọc được, bị bỏ qua', items: unreadable },
        { title: `câu có hơn ${sheet.mcq_options} đáp án, bị bỏ (chọn "Chỉ in đề" để giữ lại)`, items: tooManyOpts },
        { title: 'câu có bảng hoặc hình không đọc được, phần đó sẽ bị mất', items: info.warnings.filter(w => LOSSY.test(w)) },
      ]} />
      {info.formula_note && <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8 }}>{info.formula_note}.</div>}
    </div>
  );
}

// ── Create modal ─────────────────────────────────────────────────────────────

function CreateModal({ exams, onClose, onCreated }: {
  exams: ExamOut[];
  onClose: () => void;
  onCreated: (paper: ExamPaperOut) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<'bank' | 'file'>('bank');
  const [name, setName] = useState('');
  const [categories, setCategories] = useState<QuestionCategoryOut[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [counts, setCounts] = useState<PartCounts>({ mcq: 0, tf: 0, short: 0 });
  const [files, setFiles] = useState<File[]>([]);
  const [numVersions, setNumVersions] = useState(4);
  const [startCode, setStartCode] = useState('101');
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [examId, setExamId] = useState<number | null>(null);
  const [forSheet, setForSheet] = useState(true);
  const [sheetId, setSheetId] = useState<number | null>(null);
  const sheets = useSheets();
  const sheet = specOf(sheets, sheetId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fc = useFileCounts(source === 'file' ? files : [], forSheet, sheet);

  useEffect(() => {
    questionBankApi.listCategories().then(setCategories).catch(e => setError(errMsg(e)));
  }, []);

  // Questions available per part in the ticked categories
  const available: PartCounts = { mcq: 0, tf: 0, short: 0 };
  for (const c of categories ?? []) {
    if (!picked.has(c.id)) continue;
    for (const p of PARTS) available[p.key] += c.type_counts?.[p.key] ?? 0;
  }

  // Fill the counts in for the teacher whenever the ticked categories (or the
  // sheet/print choice) change: as many as the sheet holds, or all of them.
  const availableKey = `${available.mcq}/${available.tf}/${available.short}/${forSheet}/${sheet.id}`;
  useEffect(() => {
    const pick = (p: typeof PARTS[number]) => forSheet ? Math.min(sheet.limits[p.key], available[p.key]) : available[p.key];
    setCounts({ mcq: pick(PARTS[0]), tf: pick(PARTS[1]), short: pick(PARTS[2]) });
  }, [availableKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: number) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async () => {
    setError('');
    if (!name.trim()) { setError('Nhập tên bộ đề'); return; }
    const codeErr = versionCodes(startCode, numVersions, forSheet, sheet.code_digits).error;
    if (codeErr) { setError(codeErr); return; }
    const opts: MixOptions = { name: name.trim(), num_versions: numVersions, start_code: startCode.trim(),
      shuffle_questions: shuffleQuestions, shuffle_options: shuffleOptions,
      exam_id: forSheet ? examId : null, for_sheet: forSheet, sheet: sheet.id || undefined };
    setBusy(true);
    try {
      let paper: ExamPaperOut;
      if (source === 'bank') {
        if (picked.size === 0) throw new Error('Chọn ít nhất 1 danh mục câu hỏi');
        if (counts.mcq + counts.tf + counts.short === 0) throw new Error('Nhập số câu cho ít nhất 1 phần');
        paper = await examPapersApi.fromBank({ ...opts, category_ids: [...picked], counts });
      } else {
        if (files.length === 0) throw new Error('Chọn file đề (.docx hoặc .txt)');
        if (!fc.info) throw new Error(fc.readError || 'Đang đọc file, đợi chút');
        if (fc.empty) throw new Error('Nhập số câu cho ít nhất 1 phần');
        if (fc.tooMany) throw new Error('Số câu vượt quá số câu trên phiếu hoặc trong file');
        paper = await examPapersApi.fromFile(files, { ...opts, counts: fc.counts, answers: fc.picked });
      }
      // same as Trộn nhanh: the mã đề + đáp án come straight down as a .zip
      saveBlob(await examPapersApi.download(`${paper.id}/zip`), `${safeName(paper.name)}.zip`);
      if (source === 'file') savePicked(`mix:${filesSignature(files)}`, {});
      onCreated(paper);
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };

  const tab = (key: 'bank' | 'file', label: string) => (
    <button type="button" onClick={() => setSource(key)}
      style={{ flex: 1, border: 'none', borderBottom: `2.5px solid ${source === key ? '#C8102E' : 'transparent'}`,
        background: 'none', padding: '8px 4px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
        color: source === key ? '#C8102E' : '#6B7280' }}>
      {label}
    </button>
  );

  return (
    <Modal open onClose={onClose} title="Tạo bộ đề trộn" width={680}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Hủy</Button>
        <Button loading={busy} icon={<Shuffle size={15} />} onClick={submit}>Trộn đề &amp; tải về</Button>
      </>}>
      <div style={{ display: 'flex', borderBottom: '1px solid #E5E7EB', marginBottom: 16 }}>
        {tab('bank', 'Từ ngân hàng câu hỏi')}
        {tab('file', 'Từ file đề')}
      </div>
      <SheetSelect forSheet={forSheet} onForSheet={setForSheet} sheet={sheet} onSheet={setSheetId} sheets={sheets} />

      <label style={labelStyle}>Tên bộ đề</label>
      <input autoFocus style={{ ...inputStyle, margin: '6px 0 14px' }} value={name} onChange={e => setName(e.target.value)}
        placeholder="VD: Kiểm tra giữa kì Tin học đại cương" />

      {source === 'bank' ? <>
        <div style={labelStyle}>Lấy câu hỏi từ danh mục</div>
        <div style={{ border: '1.5px solid #E5E7EB', borderRadius: 8, maxHeight: 180, overflowY: 'auto', margin: '6px 0 14px' }}>
          {categories === null && <div style={{ padding: 10, fontSize: 13, color: '#9CA3AF' }}>Đang tải…</div>}
          {categories?.length === 0 && <div style={{ padding: 10, fontSize: 13, color: '#6B7280' }}>Chưa có danh mục nào. Vào Ngân hàng câu hỏi để thêm.</div>}
          {categories?.map(c => (
            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer',
              borderBottom: '1px solid #F3F4F6', background: picked.has(c.id) ? '#FEF2F2' : '#fff' }}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{c.name}{c.access !== 'owner' && <span style={{ fontWeight: 400, color: '#1D4ED8' }}> · của {c.owner_name}</span>}</span>
              <span style={{ fontSize: 12, color: '#6B7280', whiteSpace: 'nowrap' }}>
                {c.type_counts?.mcq ?? 0} TN · {c.type_counts?.tf ?? 0} Đ/S · {c.type_counts?.short ?? 0} TLN
              </span>
            </label>
          ))}
        </div>

        {picked.size === 0 ? (
          <div style={{ fontSize: 13, color: '#9CA3AF', marginBottom: 14 }}>Tick danh mục ở trên để chọn số câu.</div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            <PartCountInputs forSheet={forSheet} limits={sheet.limits} counts={counts} setCounts={setCounts}
              available={available} limitAvailable={available} />
          </div>
        )}
      </> : <>
        <input ref={fileRef} type="file" accept=".docx,.txt" multiple style={{ display: 'none' }}
          onChange={e => { const r = addFiles(files, e.target.files); setFiles(r.files); setError(r.error); e.target.value = ''; }} />
        {files.length === 0 ? (
          <div onClick={() => fileRef.current?.click()}
            style={{ border: '2px dashed #FECACA', background: '#FFF9F9', borderRadius: 12, padding: '18px 16px',
              textAlign: 'center', cursor: 'pointer', marginBottom: 8 }}>
            <FileUp size={20} color="#C8102E" />
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>Chọn file đề .docx hoặc .txt, được chọn nhiều file</div>
          </div>
        ) : (
          <FileList files={files} onRemove={i => setFiles(prev => prev.filter((_, k) => k !== i))} onAdd={() => fileRef.current?.click()} />
        )}
        <div style={{ fontSize: 12.5, color: '#6B7280', marginBottom: 14, lineHeight: 1.5 }}>
          Câu hỏi lấy từ file (không lưu vào ngân hàng). Cách soạn giống phần Import của Ngân hàng câu hỏi,{' '}
          <a href="/samples/de-mau-3-phan.docx" download style={{ color: '#C8102E', fontWeight: 600 }}>tải file đề mẫu</a>.
        </div>
        <FileCountsPicker fc={fc} />
      </>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
        <VersionCodeFields numVersions={numVersions} setNumVersions={setNumVersions}
          spec={startCode} setSpec={setStartCode} forSheet={forSheet} codeDigits={sheet.code_digits} />
        <div>
          <label style={labelStyle}>Gắn vào kỳ thi</label>
          <select value={forSheet ? examId ?? '' : ''} disabled={!forSheet} onChange={e => setExamId(e.target.value ? Number(e.target.value) : null)}
            style={{ ...inputStyle, marginTop: 6 }}>
            <option value="">{forSheet ? 'Chưa gắn' : 'Đề chỉ để in'}</option>
            {exams.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
          </select>
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer', marginBottom: 6 }}>
        <input type="checkbox" checked={shuffleQuestions} onChange={e => setShuffleQuestions(e.target.checked)} />
        Trộn thứ tự câu hỏi (trong từng phần)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
        <input type="checkbox" checked={shuffleOptions} onChange={e => setShuffleOptions(e.target.checked)} />
        Trộn thứ tự đáp án A/B/C/D (câu đánh dấu "không trộn" hoặc đáp án ghim # giữ nguyên)
      </label>
      {error && <div style={{ color: '#C8102E', fontSize: 13, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}

// ── One bộ đề ────────────────────────────────────────────────────────────────

function PaperCard({ paper, exams, onChanged, onDeleted, onError }: {
  paper: ExamPaperOut;
  exams: ExamOut[];
  onChanged: (p: ExamPaperOut) => void;
  onDeleted: () => void;
  onError: (msg: string) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const sheets = useSheets();

  const run = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag);
    try { await fn(); } catch (e) { onError(errMsg(e)); } finally { setBusy(null); }
  };

  const download = (path: string, filename: string) =>
    run(path, async () => saveBlob(await examPapersApi.download(`${paper.id}/${path}`), filename));

  const settings = paper.settings as { category_names?: string[]; file_name?: string; keep_format?: boolean };
  const sourceText = paper.source === 'bank'
    ? `Ngân hàng: ${(settings.category_names ?? []).join(', ') || 'không rõ'}`
    : `File: ${settings.file_name ?? 'không rõ'}`;
  // 2026-10-05: "mấy cái này làm sao cho gọn và rõ ràng": one tag per fact,
  // parts with 0 câu left out, the source on its own line (cut if long)
  const created = serverDate(paper.created_at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const tags = [
    ...PARTS.filter(p => paper.counts[p.key] > 0)
      .map(p => `${paper.counts[p.key]} ${p.key === 'mcq' ? 'trắc nghiệm' : p.key === 'tf' ? 'Đúng/Sai' : 'trả lời ngắn'}`),
    `${paper.versions.length} mã đề`,
    ...(paper.sheet == null ? ['Chỉ in đề'] : []),
    `Tạo ${pad(created.getDate())}/${pad(created.getMonth() + 1)}/${created.getFullYear()} ${pad(created.getHours())}:${pad(created.getMinutes())}`,
  ];
  const inExamCount = paper.versions.filter(v => v.in_exam).length;

  return (
    <Card style={{ padding: '16px 18px', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#1F2937' }}>
            {paper.name}
            {settings.keep_format && (
              <span title="Mã đề được dựng từ chính file Word gốc: giữ công thức, hình ảnh, bảng"
                style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#15803D', background: '#DCFCE7',
                  borderRadius: 6, padding: '2px 7px', verticalAlign: 'middle' }}>Giữ định dạng Word</span>
            )}
          </div>
          <div title={sourceText}
            style={{ fontSize: 12.5, color: '#6B7280', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sourceText}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {tags.map(t => (
              <span key={t} style={{ fontSize: 12, fontWeight: 600, color: '#374151', background: '#F3F4F6',
                borderRadius: 6, padding: '2px 8px', whiteSpace: 'nowrap' }}>{t}</span>
            ))}
          </div>
        </div>
        <Button size="sm" icon={<Download size={13} />} loading={busy === 'zip'}
          onClick={() => download('zip', `${safeName(paper.name)}.zip`)}>Tải tất cả (.zip)</Button>
        <Button size="sm" variant="outline" icon={<FileText size={13} />} loading={busy === 'answer-key/docx'}
          onClick={() => download('answer-key/docx', `${safeName(paper.name)} - Dap an.docx`)}>Đáp án (Word)</Button>
        <Button size="sm" variant="secondary" icon={<Trash2 size={13} />} style={{ color: '#EF4444', borderColor: '#FECACA' }}
          onClick={() => { if (confirm(`Xóa bộ đề "${paper.name}" và ${paper.versions.length} mã đề?`)) run('delete', async () => { await examPapersApi.delete(paper.id); onDeleted(); }); }} />
      </div>

      {/* Phiếu chấm (2026-10-06): "thế t chỉnh lại nnao" — a bộ đề mixed for
          the wrong sheet (or before the sheet could be picked) is switched
          here: same mã đề, same questions, only the sheet it is graded on. */}
      {paper.sheet != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Phiếu chấm:</span>
          <select value={String(paper.sheet)} disabled={busy === 'sheet'}
            onChange={e => {
              const id = Number(e.target.value);
              run('sheet', async () => onChanged(await examPapersApi.update(paper.id, { sheet: id })));
            }}
            style={{ ...inputStyle, width: 'auto', minWidth: 220, maxWidth: '100%', padding: '6px 8px', fontSize: 13 }}>
            {!sheets.some(sp => sp.id === paper.sheet) && <option value={String(paper.sheet)}>{paper.sheet_name ?? 'Phiếu đang dùng'}</option>}
            {sheets.map(sp => <option key={sp.id} value={String(sp.id)}>{sp.name}</option>)}
          </select>
        </div>
      )}

      {/* Kỳ thi (bước 5) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Kỳ thi:</span>
        {!paper.gradable && paper.exam_id == null ? (
          <span style={{ fontSize: 12.5, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '4px 10px' }}>
            Đề chỉ để in, không chấm được bằng phiếu{paper.sheet_problem ? ` (${paper.sheet_problem})` : ''}
          </span>
        ) : (
        <select value={paper.exam_id ?? ''} disabled={busy === 'exam'}
          onChange={e => {
            const v = e.target.value ? Number(e.target.value) : null;
            run('exam', async () => onChanged(await examPapersApi.update(paper.id, { exam_id: v })));
          }}
          style={{ ...inputStyle, width: 'auto', minWidth: 220, padding: '6px 8px', fontSize: 13 }}>
          <option value="">Chưa gắn vào kỳ thi</option>
          {exams.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
        </select>
        )}
        {paper.exam_id != null && (
          <span style={{ fontSize: 12.5, color: '#15803D' }}>
            ✓ Khi chấm kỳ thi này, đáp án {inExamCount} mã đề được điền tự động
          </span>
        )}
      </div>

      {/* Mã đề */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {paper.versions.map(v => (
          <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1.5px solid ${paper.exam_id != null && v.in_exam ? '#86EFAC' : '#E5E7EB'}`,
            borderRadius: 10, padding: '5px 8px', background: paper.exam_id != null && !v.in_exam ? '#F9FAFB' : '#fff' }}>
            {paper.exam_id != null && (
              <input type="checkbox" checked={v.in_exam} title="Dùng mã đề này trong kỳ thi" disabled={busy === `v${v.id}`}
                onChange={e => {
                  const on = e.target.checked;
                  // Show the change right away; the server reply (or the old state on error) replaces it
                  onChanged({ ...paper, versions: paper.versions.map(x => (x.id === v.id ? { ...x, in_exam: on } : x)) });
                  run(`v${v.id}`, async () => {
                    try { onChanged(await examPapersApi.setInExam(paper.id, v.id, on)); }
                    catch (err) { onChanged(paper); throw err; }
                  });
                }} />
            )}
            <span style={{ fontSize: 13.5, fontWeight: 700, color: paper.exam_id != null && !v.in_exam ? '#9CA3AF' : '#1F2937' }}>Mã {v.code}</span>
            <button type="button" title={`Tải đề mã ${v.code} (Word)`} disabled={busy === `versions/${encodeURIComponent(v.code)}/docx`}
              onClick={() => download(`versions/${encodeURIComponent(v.code)}/docx`, `${safeName(paper.name)} - Ma de ${v.code}.docx`)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#C8102E', padding: 2, display: 'flex' }}>
              <Download size={14} />
            </button>
          </div>
        ))}
      </div>
      {paper.exam_id != null && (
        <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 6 }}>Bỏ tích mã đề nào không dùng trong kỳ thi.</div>
      )}

      {/* Đáp án xem nhanh */}
      <button type="button" onClick={() => setShowKey(s => !s)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 10, border: 'none', background: 'none', padding: 0,
          cursor: 'pointer', color: '#C8102E', fontWeight: 700, fontSize: 13, fontFamily: 'inherit' }}>
        {showKey ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Xem đáp án các mã đề
      </button>
      {showKey && (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: '100%' }}>
            <tbody>
              {paper.versions.map(v => (
                <tr key={v.id} style={{ borderTop: '1px solid #F3F4F6', verticalAlign: 'top' }}>
                  <td style={{ padding: '6px 10px 6px 0', fontWeight: 700, whiteSpace: 'nowrap' }}>Mã {v.code}</td>
                  <td style={{ padding: '6px 0', lineHeight: 1.7 }}>
                    {v.answer_key.mcq.length > 0 && <div><b>I:</b> {v.answer_key.mcq.map((a, i) => `${i + 1}${a}`).join(' ')}</div>}
                    {v.answer_key.tf.length > 0 && <div><b>II:</b> {v.answer_key.tf.map((a, i) => `${i + 1}.${a.join('')}`).join('  ')}</div>}
                    {v.answer_key.short.length > 0 && <div><b>III:</b> {v.answer_key.short.map((a, i) => `${i + 1}: ${a}`).join('  ·  ')}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

// ── Trộn nhanh 1 file Word (2026-09-29) ──────────────────────────────────────
// Chức năng như youngmix.vn — thả file đề là trộn ra các mã đề để tải về, có
// hướng dẫn soạn đề, nhóm câu hỏi <g0>–<g3> và file mẫu — nhưng giao diện
// theo đúng app (Card, ô thả file giống trang Upload & Chấm, nút Button).
// Khác YoungMix: bộ đề được lưu lại để gắn vào kỳ thi và chấm theo mã đề.

const SAMPLES: { file: string; label: string; hint: string }[] = [
  { file: 'mau-de.docx',                  label: 'Đề mẫu Word (.docx)', hint: 'Đủ 3 phần như phiếu trả lời, viết đáp án bằng dòng "Đáp án:"' },
  { file: 'mau-de.txt',                   label: 'Đề mẫu .txt', hint: 'Cùng nội dung, cùng cách viết với đề mẫu Word' },
  { file: 'de-trac-nghiem-don-gian.docx', label: 'Đề trắc nghiệm đơn giản', hint: '10 câu A–D, dùng được cả khi chấm bằng phiếu lẫn chỉ in' },
  { file: 'de-chuan-mau-40.docx',         label: 'Khung đề chuẩn phiếu Mẫu 40 câu trắc nghiệm', hint: 'Đủ 40 trắc nghiệm, 8 Đúng/Sai, 6 trả lời ngắn, chỉ việc thay nội dung' },
  { file: 'de-mau-trac-nghiem-nhom.docx', label: 'Đề có nhóm câu hỏi', hint: 'Phần nghe đứng yên, đoạn đọc hiểu giữ thứ tự câu' },
  { file: 'de-mau-moodle.txt',            label: 'File Moodle (.txt)', hint: 'Định dạng khi xuất câu hỏi từ Moodle' },
  { file: 'mau-file-dap-an.xlsx',         label: 'File đáp án (Excel)', hint: 'Chọn file đề trước để có sẵn danh sách câu. Điền cột Đáp án rồi bấm "Nạp file đáp án"' },
];

/** The đáp án template: with a file chosen, it lists that file's câu chưa có đáp án. */
const ANSWER_SAMPLE = 'mau-file-dap-an.xlsx';

function downloadStatic(path: string) {
  const a = document.createElement('a');
  a.href = path;
  a.download = path.split('/').pop() ?? '';
  a.click();
}

const GROUP_RULES: { tag: string; rule: string }[] = [
  { tag: '<g0>', rule: 'Không trộn gì trong nhóm (vd phần Nghe)' },
  { tag: '<g1>', rule: 'Chỉ trộn thứ tự câu hỏi' },
  { tag: '<g2>', rule: 'Chỉ trộn đáp án, giữ thứ tự câu (vd đoạn đọc hiểu)' },
  { tag: '<g3>', rule: 'Trộn cả câu hỏi và đáp án' },
];

const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: '#C8102E', marginBottom: 4 };
const code: React.CSSProperties = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, background: '#F3F4F6', borderRadius: 4, padding: '1px 5px', color: '#1F2937' };

function QuickMix({ exams, onCreated }: {
  exams: ExamOut[];
  onCreated: (paper: ExamPaperOut) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  // kept while the teacher visits other pages (draftStore), gone on reload/logout
  const [files, setFiles] = useDraft<File[]>('quickmix.files', []);
  const [dragging, setDragging] = useState(false);
  const [name, setName] = useDraft('quickmix.name', '');
  const [numVersions, setNumVersions] = useDraft('quickmix.numVersions', 4);
  const [startCode, setStartCode] = useDraft('quickmix.startCode', '101');
  const [shuffleQuestions, setShuffleQuestions] = useDraft('quickmix.shuffleQuestions', true);
  const [shuffleOptions, setShuffleOptions] = useDraft('quickmix.shuffleOptions', true);
  const [examId, setExamId] = useDraft<number | null>('quickmix.examId', null);
  const [forSheet, setForSheet] = useDraft('quickmix.forSheet', true);
  const [sheetId, setSheetId] = useDraft<number | null>('quickmix.sheetId', null);
  const sheets = useSheets();
  const sheet = specOf(sheets, sheetId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fc = useFileCounts(files, forSheet, sheet, 'quickmix');

  const autoName = (fs: File[]) =>
    fs.length === 0 ? '' : fs.length === 1 ? fs[0].name.replace(/\.(docx|txt)$/i, '') : `Đề gộp ${fs.length} file`;
  const setChosen = (next: File[]) => {
    // keep a name the teacher typed; otherwise follow the files
    setName(prev => (prev === '' || prev === autoName(files) ? autoName(next) : prev));
    setFiles(next);
  };
  const pick = (list: FileList | null | undefined) => {
    const r = addFiles(files, list);
    setError(r.error);
    setChosen(r.files);
  };

  const downloadAnswerTemplate = async () => {
    if (!fc.info) return;
    const { answerTemplate } = await import('../utils/pickedAnswersExcel');
    saveAs(await answerTemplate(fc.info.mcq_all, fc.picked),
      `Dap an - ${fc.fileName.replace(/\.(docx|txt)$/i, '')}.xlsx`);
  };

  const mix = async () => {
    if (files.length === 0) return;
    setError('');
    if (!name.trim()) { setError('Nhập tên bộ đề'); return; }
    const codeErr = versionCodes(startCode, numVersions, forSheet, sheet.code_digits).error;
    if (codeErr) { setError(codeErr); return; }
    if (!fc.info) { setError(fc.readError || 'Đang đọc file, đợi chút'); return; }
    if (fc.empty) { setError('Nhập số câu cho ít nhất 1 phần'); return; }
    if (fc.tooMany) { setError('Số câu vượt quá số câu trên phiếu hoặc trong file'); return; }
    setBusy(true);
    try {
      const paper = await examPapersApi.fromFile(files, {
        name: name.trim(), num_versions: numVersions, start_code: startCode.trim(),
        shuffle_questions: shuffleQuestions, shuffle_options: shuffleOptions,
        exam_id: forSheet ? examId : null, for_sheet: forSheet, sheet: sheet.id || undefined, counts: fc.counts, answers: fc.picked,
      });
      saveBlob(await examPapersApi.download(`${paper.id}/zip`), `${safeName(paper.name)}.zip`);
      onCreated(paper);
      savePicked(`mix:${filesSignature(files)}`, {});   // done with this file's picks
      setChosen([]);
    } catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {/* Left: file + options */}
      <Card style={{ flex: '1 1 460px', minWidth: 0 }}>
        <div style={{ ...sectionTitle, marginBottom: 12 }}>Trộn nhanh từ file Word</div>

        {files.length === 0 ? (
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files); }}
            onClick={() => fileRef.current?.click()}
            style={{
              border: `2px dashed ${dragging ? '#C8102E' : '#FECACA'}`, borderRadius: 14, padding: '32px 20px',
              textAlign: 'center', cursor: 'pointer', background: dragging ? '#FFF5F5' : '#FFF9F9',
              transition: 'border-color 140ms, background 140ms',
            }}
          >
            <FileText size={34} color={dragging ? '#C8102E' : '#FCA5A5'} style={{ margin: '0 auto 8px' }} />
            <p style={{ margin: '0 0 6px', fontWeight: 600, fontSize: 15, color: '#374151' }}>Kéo thả file đề vào đây</p>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#9CA3AF' }}>Word .docx hoặc .txt, được chọn nhiều file</p>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1.5px solid #C8102E', borderRadius: 9999,
              padding: '6px 16px', fontSize: 12.5, fontWeight: 700, color: '#fff', background: '#C8102E' }}>
              <FileUp size={13} /> Chọn file
            </span>
          </div>
        ) : (
          <>
            <FileList files={files} onRemove={i => setChosen(files.filter((_, k) => k !== i))} onAdd={() => fileRef.current?.click()} />
            <SheetSelect forSheet={forSheet} onForSheet={setForSheet} sheet={sheet} onSheet={setSheetId} sheets={sheets} />
            <FileCountsPicker fc={fc} />
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Tên bộ đề</label>
              <input style={{ ...inputStyle, marginTop: 6 }} value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
              <VersionCodeFields numVersions={numVersions} setNumVersions={setNumVersions}
                spec={startCode} setSpec={setStartCode} forSheet={forSheet} codeDigits={sheet.code_digits} />
              {forSheet && (
                <div>
                  <label style={labelStyle}>Gắn vào kỳ thi</label>
                  <select value={examId ?? ''} onChange={e => setExamId(e.target.value ? Number(e.target.value) : null)} style={{ ...inputStyle, marginTop: 6 }}>
                    <option value="">Không gắn</option>
                    {exams.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                <input type="checkbox" checked={shuffleQuestions} onChange={e => setShuffleQuestions(e.target.checked)} /> Trộn câu hỏi
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                <input type="checkbox" checked={shuffleOptions} onChange={e => setShuffleOptions(e.target.checked)} /> Trộn đáp án
              </label>
              <div style={{ flex: 1 }} />
              <Button variant="secondary" onClick={() => { setChosen([]); setError(''); }}>Hủy</Button>
              <Button loading={busy} disabled={fc.reading || !!fc.readError} icon={<Shuffle size={15} />} onClick={mix}>Trộn đề &amp; tải về</Button>
            </div>
          </>
        )}
        <input ref={fileRef} type="file" accept=".docx,.txt" multiple style={{ display: 'none' }}
          onChange={e => { pick(e.target.files); e.target.value = ''; }} />
        {error && <div style={{ color: '#C8102E', fontSize: 13, marginTop: 10 }}>⚠ {error}</div>}
      </Card>

      {/* Right: how to write the file + samples */}
      <Card style={{ flex: '1 1 320px', minWidth: 0, maxWidth: 520 }}>
        <div style={sectionTitle}>Cách soạn file đề</div>
        <ul style={{ margin: '6px 0 10px', paddingLeft: 18, fontSize: 13, color: '#374151', lineHeight: 1.7, listStyle: 'disc' }}>
          <li>Câu hỏi: <span style={code}>Câu 1.</span> hoặc <span style={code}>1.</span></li>
          <li>Đáp án: <span style={code}>A.</span> <span style={code}>B.</span> <span style={code}>C.</span> <span style={code}>D.</span>, đáp án đúng <b style={{ color: '#E00' }}>tô đỏ</b> hoặc <u>gạch chân</u></li>
          <li>Đề 3 phần: thêm dòng <span style={code}>PHẦN I-II</span>, <span style={code}>PHẦN III</span>, <span style={code}>PHẦN IV</span> (như trên phiếu)</li>
          <li>Công thức, hình ảnh: giữ nguyên khi trộn (1 file Word giữ cả bảng và định dạng)</li>
          <li>Chưa đánh dấu đáp án: chọn ngay trên trang sau khi chọn file, hoặc điền File đáp án (Excel) bên dưới</li>
        </ul>
        <details style={{ fontSize: 13, color: '#374151', marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer', color: '#C8102E', fontWeight: 600 }}>Xem thêm</summary>
          <ul style={{ margin: '8px 0 10px', paddingLeft: 18, lineHeight: 1.7, listStyle: 'disc' }}>
            <li>Nhiều đáp án trên một dòng thì cách nhau bằng Tab</li>
            <li><span style={code}>#A.</span> giữ cố định vị trí đáp án đó</li>
            <li>Có thể ghi đáp án bằng dòng <span style={code}>Đáp án: B</span></li>
            <li>Phần III (Đúng/Sai): 4 ý <span style={code}>a)</span> đến <span style={code}>d)</span>, ý đúng tô đỏ hoặc gạch chân</li>
            <li>Phần IV (trả lời ngắn): dòng <span style={code}>Đáp án: -1,5</span></li>
            <li>File đánh số kiểu Bộ GD (Phần I, II, III) vẫn đọc đúng</li>
          </ul>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Nhóm câu hỏi</div>
          <div style={{ fontSize: 12.5, color: '#6B7280', marginBottom: 4 }}>Thêm 1 dòng ngay trên mỗi nhóm. Thêm <span style={code}>#</span> (vd <span style={code}>&lt;#g0&gt;</span>) để nhóm đứng yên.</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {GROUP_RULES.map(g => (
                <tr key={g.tag} style={{ borderTop: '1px solid #F3F4F6' }}>
                  <td style={{ padding: '5px 10px 5px 0', whiteSpace: 'nowrap', verticalAlign: 'top' }}><span style={code}>{g.tag}</span></td>
                  <td style={{ padding: '5px 0' }}>{g.rule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>

        {forSheet && (
          <div style={{ border: '1px solid #FECACA', background: '#FFF9F9', borderRadius: 10, padding: '10px 12px', marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Khi chấm bằng {sheet.name}</div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, color: '#374151', lineHeight: 1.7, listStyle: 'disc' }}>
              <li>{sheetSummary(sheet).replace(/, (mã đề|không có ô).*$/, '')}</li>
              <li>Mỗi câu trắc nghiệm tối đa {sheet.mcq_options} đáp án A–{LETTERS[sheet.mcq_options - 1] ?? 'D'}</li>
              {sheet.limits.short > 0 && <li>Trả lời ngắn tối đa 4 ký tự (vd <span style={code}>-1,5</span>)</li>}
              <li>{sheet.code_digits == null ? 'Phiếu không có ô mã đề: chỉ trộn được 1 mã đề' : `Mã đề là số (vd 101), tối đa ${sheet.code_digits} chữ số`}</li>
            </ul>
          </div>
        )}

        <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>File mẫu</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {SAMPLES.map(s => {
            // a file chosen: its own file đáp án, every trắc nghiệm with the answers it has
            const forFile = s.file === ANSWER_SAMPLE && (fc.info?.mcq_all.length ?? 0) > 0;
            return (
            <div key={s.file} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1F2937' }}>{s.label}</div>
                <div style={{ fontSize: 12, color: '#9CA3AF' }}>
                  {forFile
                    ? `Có sẵn ${fc.info!.mcq_all.length} câu trắc nghiệm của file đang chọn${fc.info!.unanswered.length ? `, ${fc.info!.unanswered.length} câu cần điền đáp án` : ', kèm đáp án trong file'}`
                    : s.hint}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <Button size="sm" variant="secondary" icon={<Download size={13} />}
                  onClick={() => (forFile ? downloadAnswerTemplate() : downloadStatic(`/samples/${s.file}`))}>Tải về</Button>
              </div>
            </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

export default function ExamPapersPage() {
  const [papers, setPapers] = useState<ExamPaperOut[] | null>(null);
  const [exams, setExams] = useState<ExamOut[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<string[]>([]);

  const load = useCallback(async () => {
    try { setPapers(await examPapersApi.list()); setError(''); }
    catch (e) { setError(errMsg(e)); setPapers([]); }
  }, []);

  useEffect(() => {
    load();
    examsApi.list().then(setExams).catch(() => setExams([]));
  }, [load]);

  const replace = (p: ExamPaperOut) => setPapers(prev => prev?.map(x => (x.id === p.id ? p : x)) ?? null);
  const created = (p: ExamPaperOut, downloaded: boolean) => {
    setPapers(prev => [p, ...(prev ?? [])]);
    setNotice([
      `Đã trộn "${p.name}" thành ${p.versions.length} mã đề (${p.versions.map(v => v.code).join(', ')})${downloaded ? ', file .zip đang tải về' : ''}`,
      ...(p.notes ?? []),
    ]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title="Trộn đề"
        subtitle="Trộn đề Word thành nhiều mã đề hoặc trộn từ ngân hàng câu hỏi, rồi gắn vào kỳ thi để chấm tự động theo mã đề"
        actions={<Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setCreateOpen(true)}>Trộn từ ngân hàng câu hỏi</Button>}
      />
      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {error && (
          <Card style={{ padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA' }}>
            <div style={{ fontSize: 13, color: '#C8102E' }}>⚠ {error}</div>
          </Card>
        )}
        {notice.length > 0 && (
          <Card style={{ padding: '10px 14px', background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
            {notice.map((n, i) => <div key={i} style={{ fontSize: 13, color: i === 0 ? '#15803D' : '#92400E' }}>{i === 0 ? '✓ ' : '• '}{n}</div>)}
          </Card>
        )}

        <QuickMix exams={exams} onCreated={p => created(p, true)} />

        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1F2937', margin: '4px 0 12px' }}>
            Bộ đề đã trộn {papers && papers.length > 0 && <span style={{ color: '#9CA3AF', fontWeight: 600 }}>({papers.length})</span>}
          </div>
          {papers === null && <div style={{ fontSize: 13, color: '#9CA3AF' }}>Đang tải…</div>}
          {papers?.length === 0 && (
            <div style={{ fontSize: 13.5, color: '#6B7280' }}>
              Chưa có bộ đề nào. Chọn file đề ở trên hoặc bấm <b>Trộn từ ngân hàng câu hỏi</b>.
            </div>
          )}
          {papers?.map(p => (
            <PaperCard key={p.id} paper={p} exams={exams} onChanged={replace} onError={setError}
              onDeleted={() => setPapers(prev => prev?.filter(x => x.id !== p.id) ?? null)} />
          ))}
        </div>
      </div>

      {createOpen && (
        <CreateModal exams={exams} onClose={() => setCreateOpen(false)}
          onCreated={p => { setCreateOpen(false); created(p, true); }} />
      )}
    </div>
  );
}
