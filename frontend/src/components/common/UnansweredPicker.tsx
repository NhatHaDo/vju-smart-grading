/**
 * Shared by Trộn đề and Ngân hàng câu hỏi (import): the list of trắc nghiệm a
 * file doesn't mark an answer for, and the one-line amber note for what a
 * file loses or skips.
 *
 * Picking 283 answers by mouse is slow, so besides the A/B/C/D buttons:
 *   - keyboard: click a câu, then type A/B/C/D: it's set and the next câu is
 *     selected (↑/↓ move, Backspace clears);
 *   - "Dán đáp án": paste the whole key at once, "ACBD…" in order or
 *     "1A 2C 3B…";
 *   - "File đáp án": download an Excel of the đề's trắc nghiệm, fill the
 *     Đáp án column, load it back (or a .csv / .txt key, or a VJU answer key).
 * Everywhere "#n" = the n-th trắc nghiệm of the file (mcq_no), not the
 * file's own numbers (those restart per chương).
 */
import { useEffect, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import type { UnansweredQuestion } from '../../services/apiClient';
import RichText, { plainText } from './RichText';

const LETTERS = 'ABCDEFGH';

/** Pasted đáp án → {#n (n-th trắc nghiệm, 1-based): option}. Without
 *  numbers, letters fill #1, #2… in order; "-", "_", "?" or "x" skip one. */
export function parseAnswerText(text: string): Map<number, number> {
  const out = new Map<number, number>();
  const pairs = [...text.matchAll(/(\d+)\s*[.\-:)\]]?\s*([A-Ha-h])(?![A-Za-z])/g)];
  if (pairs.length > 0) {
    for (const m of pairs) out.set(Number(m[1]), LETTERS.indexOf(m[2].toUpperCase()));
    return out;
  }
  let pos = 1;
  for (const ch of text) {
    if (/[A-Ha-h]/.test(ch)) out.set(pos++, LETTERS.indexOf(ch.toUpperCase()));
    else if (/[-_?xX]/.test(ch)) pos++;
  }
  return out;
}

const fileBtn: React.CSSProperties = {
  border: '1.5px solid #E5E7EB', background: '#fff', borderRadius: 7, padding: '4px 10px', fontSize: 12.5,
  fontWeight: 600, color: '#374151', cursor: 'pointer', fontFamily: 'inherit',
};

const linkBtn: React.CSSProperties = {
  border: 'none', background: 'none', padding: 0, color: '#B45309', fontWeight: 700, fontSize: 12.5,
  cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
};

export function UnansweredPicker({ list, all, picked, setPicked, hint, fileName }: {
  /** the trắc nghiệm still without an answer */
  list: UnansweredQuestion[];
  /** every trắc nghiệm of the file (with the answer it marks): for the file đáp án */
  all: UnansweredQuestion[];
  picked: Record<number, number>;
  setPicked: React.Dispatch<React.SetStateAction<Record<number, number>>>;
  hint: string;
  /** the đề's file name, to name the Excel template after it */
  fileName?: string;
}) {
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState<number | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteNote, setPasteNote] = useState('');
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const answerFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active != null) rows.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (list.length === 0) return null;
  const done = list.filter(u => picked[u.i] != null).length;

  const choose = (k: number, oi: number | null) => setPicked(prev => {
    const next = { ...prev };
    if (oi == null) delete next[list[k].i]; else next[list[k].i] = oi;
    return next;
  });

  const onKey = (e: React.KeyboardEvent) => {
    if (active == null || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toUpperCase();
    const oi = LETTERS.indexOf(key);
    if (key.length === 1 && oi >= 0) {
      if (oi >= list[active].options.length) return;
      choose(active, oi);
      setActive(Math.min(active + 1, list.length - 1));
    } else if (e.key === 'ArrowDown') setActive(Math.min(active + 1, list.length - 1));
    else if (e.key === 'ArrowUp') setActive(Math.max(active - 1, 0));
    else if (e.key === 'Backspace' || e.key === 'Delete') choose(active, null);
    else return;
    e.preventDefault();
  };

  /** {#n: option} → picked; says what was filled / skipped. A câu the file
   *  already answers keeps the file's answer (reported when it differs). */
  const applyMap = (got: Map<number, number>, what: string, note = '') => {
    const byNo = new Map(all.map(u => [u.mcq_no, u]));
    const toAnswer = new Set(list.map(u => u.i));  // still to answer (a bank's copy may have one already)
    let filled = 0, same = 0, known = 0;
    const bad: string[] = [], differ: number[] = [];
    const next = { ...picked };
    for (const [no, oi] of got) {
      const u = byNo.get(no);
      if (!u) { bad.push(`#${no} không có (file có ${all.length} câu trắc nghiệm)`); continue; }
      if (oi >= u.options.length) { bad.push(`#${no} chỉ có ${u.options.length} đáp án`); continue; }
      if (u.answer >= 0) { if (u.answer === oi) same++; else differ.push(no); continue; }
      if (!toAnswer.has(u.i)) { known++; continue; }
      next[u.i] = oi; filled++;
    }
    setPicked(next);
    const msg = got.size === 0 ? `Không thấy đáp án nào trong ${what}.`
      : `Đã điền ${filled} câu.`
        + (same ? ` ${same} câu trùng đáp án có sẵn trong file đề.` : '')
        + (known ? ` ${known} câu đã có đáp án trong ngân hàng, giữ nguyên.` : '')
        + (differ.length ? ` ${differ.length} câu khác đáp án trong file đề, giữ đáp án của file đề (#${differ.slice(0, 5).join(', #')}${differ.length > 5 ? '…' : ''}).` : '')
        + (bad.length ? ` Bỏ qua: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? '…' : ''}.` : '');
    setPasteNote(note ? `${note} ${msg}` : msg);
    return filled > 0 && bad.length === 0;
  };

  const applyPaste = () => {
    if (applyMap(parseAnswerText(pasteText), 'đoạn dán')) setPasteText('');
  };

  // exceljs is big: only loaded when a teacher actually uses the file buttons
  const downloadTemplate = async () => {
    const { answerTemplate } = await import('../../utils/pickedAnswersExcel');
    const base = (fileName || 'de').replace(/\.(docx|txt)$/i, '');
    saveAs(await answerTemplate(all, picked), `Dap an - ${base}.xlsx`);
  };
  const loadAnswerFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const { readAnswerFile } = await import('../../utils/pickedAnswersExcel');
      const got = await readAnswerFile(f);
      applyMap(got.byMcq, `file ${f.name}`, got.note);
    } catch {
      setPasteNote(`Không đọc được file ${f.name}. Dùng file Excel mẫu, .csv hoặc .txt.`);
    }
  };

  return (
    <div style={{ border: '1.5px solid #FDE68A', background: '#FFFBEB', borderRadius: 10, padding: '10px 12px', margin: '0 0 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#92400E', lineHeight: 1.5 }}>
          <b>{list.length} câu chưa có đáp án</b> (đã chọn {done}/{list.length}).{' '}
          {hint}
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button type="button" style={linkBtn} onClick={() => { setPasteOpen(o => !o); setOpen(true); setPasteNote(''); }}>
            Nhập đáp án nhanh
          </button>
          <button type="button" style={linkBtn} onClick={() => setOpen(o => !o)}>{open ? 'Thu gọn' : 'Chọn đáp án'}</button>
        </div>
      </div>

      {open && pasteOpen && (
        <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff', border: '1px solid #FDE68A', borderRadius: 8 }}>
          <input ref={answerFileRef} type="file" accept=".xlsx,.csv,.txt" style={{ display: 'none' }}
            onChange={e => { loadAnswerFile(e.target.files?.[0]); e.target.value = ''; }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: '#374151' }}>File đáp án:</span>
            <button type="button" onClick={downloadTemplate} style={fileBtn}>Tải file mẫu (Excel)</button>
            <button type="button" onClick={() => answerFileRef.current?.click()} style={fileBtn}>Nạp file đáp án</button>
            <span style={{ fontSize: 12, color: '#6B7280' }}>
              File mẫu có sẵn mọi câu trắc nghiệm của đề (kèm đáp án đã có), chỉ cần điền cột Đáp án. Cũng nạp được file đáp án mẫu VJU (xuất từ trang Answer Key)
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: '#374151', lineHeight: 1.5, marginBottom: 6 }}>
            Hoặc dán cả bảng đáp án một lần: <code>ACBDA BCCAD…</code> (từ câu trắc nghiệm #1; dấu <code>-</code> để bỏ qua 1 câu)
            hoặc <code>1A 2C 3B…</code> (số là # = thứ tự câu trắc nghiệm trong file, như trong danh sách dưới).
          </div>
          <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={3}
            placeholder="VD: ACBDA BCCAD DABCA hoặc 1A 2C 3B"
            style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E5E7EB', borderRadius: 7, padding: '6px 8px',
              fontSize: 13, fontFamily: 'ui-monospace, monospace', resize: 'vertical' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
            <button type="button" onClick={applyPaste} disabled={!pasteText.trim()}
              style={{ border: 'none', borderRadius: 7, padding: '5px 14px', background: '#C8102E', color: '#fff', fontWeight: 700,
                fontSize: 12.5, cursor: pasteText.trim() ? 'pointer' : 'default', opacity: pasteText.trim() ? 1 : 0.5, fontFamily: 'inherit' }}>
              Điền
            </button>
            {done > 0 && (
              <button type="button" style={{ ...linkBtn, color: '#6B7280' }} onClick={() => { setPicked({}); setPasteNote('Đã xóa hết đáp án đã chọn.'); }}>
                Xóa hết đáp án đã chọn
              </button>
            )}
            {pasteNote && <span style={{ fontSize: 12.5, color: '#92400E' }}>{pasteNote}</span>}
          </div>
        </div>
      )}

      {open && (
        <>
          <div style={{ fontSize: 12, color: '#B45309', marginTop: 8 }}>
            Mẹo: bấm vào 1 câu rồi gõ phím A, B, C, D trên bàn phím, tự chuyển sang câu tiếp theo.
          </div>
          <div tabIndex={0} onKeyDown={onKey} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(null); }}
            style={{ maxHeight: 340, overflowY: 'auto', marginTop: 6, borderTop: '1px solid #FDE68A', outline: 'none' }}>
            {list.map((u, k) => (
              <div key={u.i} ref={el => { rows.current[k] = el; }} onMouseDown={() => setActive(k)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 6px', cursor: 'pointer',
                  borderBottom: '1px solid #FEF3C7', borderRadius: 6,
                  background: active === k ? '#FEF3C7' : 'transparent',
                  boxShadow: active === k ? 'inset 3px 0 0 #D97706' : 'none' }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: '#374151' }}>
                  <span style={{ color: '#9CA3AF', marginRight: 4 }}>#{u.mcq_no}</span>
                  <b>{u.number || u.where}</b> {u.content ? <RichText text={u.content} /> : <i style={{ color: '#9CA3AF' }}>(công thức / hình ảnh)</i>}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {u.options.map((o, oi) => {
                    const on = picked[u.i] === oi;
                    return (
                      <button key={oi} type="button" tabIndex={-1} title={plainText(o) || '(công thức / hình ảnh)'}
                        onClick={() => choose(k, on ? null : oi)}
                        style={{ width: 30, height: 28, borderRadius: 7, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                          fontFamily: 'inherit', border: `1.5px solid ${on ? '#C8102E' : '#E5E7EB'}`,
                          background: on ? '#C8102E' : '#fff', color: on ? '#fff' : '#374151' }}>
                        {LETTERS[oi]}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** A warning about a part of a câu that can't be kept (a table, an unreadable picture): the câu is still used. */
export const LOSSY = /bị mất/;

/** One amber line for everything left out of the file, details on demand. */
export function FileNote({ groups }: { groups: { title: string; items: string[] }[] }) {
  const [open, setOpen] = useState(false);
  const shown = groups.filter(g => g.items.length > 0);
  if (shown.length === 0) return null;
  return (
    <div style={{ fontSize: 12.5, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8,
      padding: '6px 10px', marginTop: 8, lineHeight: 1.5 }}>
      <div>
        {shown.map(g => `${g.items.length} ${g.title}`).join('; ')}.{' '}
        <button type="button" onClick={() => setOpen(o => !o)}
          style={{ border: 'none', background: 'none', padding: 0, color: '#B45309', fontWeight: 700, fontSize: 12.5,
            cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>
          {open ? 'Ẩn' : 'Xem'}
        </button>
      </div>
      {open && shown.map(g => (
        <ul key={g.title} style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 160, overflowY: 'auto', listStyle: 'disc' }}>
          {g.items.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      ))}
    </div>
  );
}
