/**
 * Question text with its formulas / pictures (2026-10-01).
 *
 * A Word đề's MathType formulas and pictures are kept as "[[ct:<id>]]" tokens
 * in the question text (backend: services/rich_objects.py); each is drawn here
 * as its SVG, sized in points like in Word so it sits in the line of text.
 * When the server couldn't draw one (no LibreOffice) a small "[công thức]"
 * placeholder shows instead — the formula itself is still kept for Word files.
 */
import { useState } from 'react';
import { questionAssetUrl } from '../../services/apiClient';

const TOKEN = /\[\[ct:([0-9a-f]{8,40})\]\]/g;

/** Text with tokens replaced, for places that can't show a picture (titles, tooltips). */
export function plainText(text: string, placeholder = '[công thức]') {
  return (text || '').replace(TOKEN, placeholder);
}

export function hasFormula(text: string) {
  return /\[\[ct:[0-9a-f]{8,40}\]\]/.test(text || '');
}

function Formula({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span title="Công thức (xem trong file Word)" style={{ display: 'inline-block', padding: '0 4px', margin: '0 1px',
        border: '1px dashed #D1D5DB', borderRadius: 4, fontSize: '0.85em', color: '#6B7280', background: '#F9FAFB' }}>
        công thức
      </span>
    );
  }
  return (
    <img src={questionAssetUrl(id)} alt="công thức" onError={() => setFailed(true)} loading="lazy"
      style={{ display: 'inline-block', verticalAlign: 'middle', maxWidth: '100%', margin: '0 1px' }} />
  );
}

export default function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of (text || '').matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(<Formula key={`${at}-${m[1]}`} id={m[1]} />);
    last = at + m[0].length;
  }
  if (last < (text || '').length) parts.push(text.slice(last));
  return <>{parts}</>;
}
