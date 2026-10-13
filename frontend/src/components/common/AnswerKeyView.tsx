/**
 * AnswerKeyView.tsx — the đáp án behind a mã QR, read-only: one tab per mã
 * đề, the answers grouped by phần (label prefixes: trc_nghim_abcd1… = Phần 1,
 * the Đúng/Sai labels = Phần 2, …). Used by the public /qr page and the
 * Answer Key page's "Quét mã QR" preview.
 */
import { useState } from 'react';
import type { PublicAnswerKey } from '../../services/apiClient';

const PART = /^(.*?)(\d+[a-dA-D]?)$/;

function parts(answers: Record<string, string>): { name: string; items: [string, string][] }[] {
  const out: { name: string; items: [string, string][] }[] = [];
  let last: string | null = null;
  for (const [label, ans] of Object.entries(answers)) {
    const m = label.match(PART);
    // all-digit field ids (trả lời ngắn) form one phần of their own
    const prefix = /^\d{5,}$/.test(label) ? '#id' : (m ? m[1] : label);
    const num = m ? m[2] : label;
    if (prefix !== last) { out.push({ name: `Phần ${out.length + 1}`, items: [] }); last = prefix; }
    const items = out[out.length - 1].items;
    // field ids (long numbers) of trả lời ngắn → 1, 2, 3… in that phần
    items.push([/^\d{5,}$/.test(num) ? String(items.length + 1) : num, ans]);
  }
  return out;
}

export default function AnswerKeyView({ data }: { data: PublicAnswerKey }) {
  const codes = Object.keys(data.byMaDe).sort();
  const [code, setCode] = useState(codes[0] ?? '');
  const answers = data.byMaDe[code] ?? {};
  const ps = parts(answers);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {codes.length > 1 || (codes.length === 1 && codes[0]) ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {codes.map(c => (
            <button key={c} type="button" onClick={() => setCode(c)}
              style={{ border: `1.5px solid ${c === code ? '#C8102E' : '#E5E7EB'}`, background: c === code ? '#FEF2F2' : '#fff',
                color: c === code ? '#C8102E' : '#374151', borderRadius: 9999, padding: '5px 12px', fontSize: 13,
                fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              Mã đề {c}
            </button>
          ))}
        </div>
      ) : null}
      {ps.length === 0 && <div style={{ fontSize: 13, color: '#9CA3AF' }}>Chưa có đáp án.</div>}
      {ps.map(p => (
        <div key={p.name}>
          {ps.length > 1 && <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', margin: '2px 0 6px' }}>{p.name}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(62px, 1fr))', gap: 6 }}>
            {p.items.map(([n, a]) => (
              <span key={n} style={{ fontSize: 13, background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 6,
                padding: '4px 6px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#6B7280' }}>{n}</span> <b>{a || '–'}</b>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
