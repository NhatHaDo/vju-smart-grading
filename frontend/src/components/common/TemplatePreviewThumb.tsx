import { useEffect, useState } from 'react';
import type { TemplateSchema } from '../../types/grading';

// 2026-07-30: "ở mục chọn template để chấm, chọn mục nào GV cần nhìn được
// template đó là như thế nào" — teachers picking a template (in AnswerKeyPage's
// direct-open picker and the Upload page's picker) previously only saw a name
// in a radio/dropdown list, with no way to confirm it's the right sheet layout
// before committing. Custom templates carry real block geometry (`areas` +
// `page_width`/`page_height`) from the Define-Areas wizard, so we can draw a
// schematic (not a photo — no sheet photo is ever persisted server-side) of
// where every field sits on the page. VJU's built-in presets have no such
// geometry (they're a fixed compiled layout, not user-drawn areas), so those
// fall back to a plain text summary of their fields/sections instead.

export interface TemplateAreaLike {
  box?:        [number, number, number, number];
  label?:      string;
  blockName?:  string;
  type?:       string;
  fieldType?:  string;
}

interface Props {
  loading?:    boolean;
  areas?:      TemplateAreaLike[] | null;
  pageWidth?:  number | null;
  pageHeight?: number | null;
  /** Fallback when there's no area geometry (e.g. VJU built-in presets) —
   *  renders a plain-text field/section summary instead of a diagram. */
  schema?:     TemplateSchema | null;
  height?:     number;
  /** 2026-07-30: real reference photo for a fixed VJU preset (SBD4/SBD8/
   *  pinned "Mẫu 40") — these have no drawn `areas` geometry to render a
   *  schematic from, so a real photo is the only way to show "what does
   *  this template actually look like". Static asset path under /public;
   *  if the file doesn't exist yet (photo not supplied), this quietly
   *  falls back to the schema text-summary below instead of a broken-image
   *  icon — so this can ship before the real photos are dropped in. */
  imageUrl?:   string | null;
}

const TYPE_COLOR: Record<string, string> = {
  QTYPE_INT:        '#DBEAFE',
  QTYPE_TRUE_FALSE: '#FEF3C7',
  QTYPE_4CHOICE:    '#FCE7F3',
  QTYPE_DECIMAL:    '#E0E7FF',
};
const TYPE_BORDER: Record<string, string> = {
  QTYPE_INT:        '#93C5FD',
  QTYPE_TRUE_FALSE: '#FCD34D',
  QTYPE_4CHOICE:    '#F9A8D4',
  QTYPE_DECIMAL:    '#A5B4FC',
};

export default function TemplatePreviewThumb({ loading, areas, pageWidth, pageHeight, schema, height = 150, imageUrl }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  // 2026-07-30 fix: `imgFailed` used to get stuck permanently once one
  // imageUrl attempt failed (e.g. the initial render defaults to the sbd8
  // variant before an effect restores the actual "last used" sbd4 selection
  // — that first sbd8 request 404s, and since this component never
  // remounts as the parent switches variants, the image would never be
  // retried again even after imageUrl pointed at a real, working photo).
  // Reset the failed flag whenever the URL we're asked to show changes.
  useEffect(() => { setImgFailed(false); }, [imageUrl]);
  const boxStyle = {
    width: '100%', height, borderRadius: 10, border: '1.5px solid #E5E7EB',
    background: '#FAFAFB', display: 'flex', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden', position: 'relative' as const,
  };

  if (loading) {
    return (
      <div style={boxStyle}>
        <span style={{ fontSize: 12, color: '#9CA3AF' }}>Đang tải xem trước…</span>
      </div>
    );
  }

  if (imageUrl && !imgFailed) {
    return (
      <div style={boxStyle}>
        <img
          src={imageUrl}
          alt="Ảnh minh họa mẫu phiếu"
          onError={() => setImgFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </div>
    );
  }

  if (areas && areas.length > 0 && pageWidth && pageHeight) {
    return (
      <div style={boxStyle}>
        <svg viewBox={`0 0 ${pageWidth} ${pageHeight}`} style={{ width: '100%', height: '100%' }} preserveAspectRatio="xMidYMid meet">
          <rect x={0} y={0} width={pageWidth} height={pageHeight} fill="#fff" stroke="#D1D5DB" strokeWidth={Math.max(pageWidth, pageHeight) / 250} />
          {areas.map((a, i) => {
            if (!a.box || a.box.length !== 4) return null;
            const [x0, y0, x1, y1] = a.box;
            const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
            const fill   = TYPE_COLOR[a.fieldType ?? '']  ?? '#F3F4F6';
            const stroke = TYPE_BORDER[a.fieldType ?? ''] ?? '#D1D5DB';
            return (
              <rect key={i} x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={w} height={h}
                fill={fill} stroke={stroke} strokeWidth={Math.max(pageWidth, pageHeight) / 400} rx={Math.max(pageWidth, pageHeight) / 200} />
            );
          })}
        </svg>
        <span style={{ position: 'absolute', bottom: 4, right: 6, fontSize: 9.5, color: '#9CA3AF', background: 'rgba(255,255,255,0.85)', padding: '1px 5px', borderRadius: 4 }}>
          Sơ đồ vùng đọc — không phải ảnh thật của phiếu
        </span>
      </div>
    );
  }

  if (schema && (schema.infoFields.length > 0 || schema.answerSections.length > 0)) {
    return (
      <div style={{ ...boxStyle, flexDirection: 'column', alignItems: 'flex-start', padding: 12, gap: 8 }}>
        <div style={{ fontSize: 10.5, color: '#9CA3AF' }}>
          {imageUrl ? 'Ảnh minh họa sẽ được cập nhật sau — tạm thời xem cấu trúc mẫu:' : 'Không có sơ đồ hình ảnh cho mẫu chuẩn — cấu trúc mẫu:'}
        </div>
        {schema.infoFields.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {schema.infoFields.map(f => (
              <span key={f.key} style={{ fontSize: 10.5, fontWeight: 600, color: '#1D4ED8', background: '#DBEAFE', borderRadius: 6, padding: '2px 7px' }}>{f.displayName}</span>
            ))}
          </div>
        )}
        {schema.answerSections.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {schema.answerSections.map(s => (
              <span key={s.name} style={{ fontSize: 10.5, fontWeight: 600, color: '#C8102E', background: '#FEF2F2', borderRadius: 6, padding: '2px 7px' }}>
                {s.name} ({s.labels.length})
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={boxStyle}>
      <span style={{ fontSize: 12, color: '#9CA3AF' }}>Chưa có xem trước</span>
    </div>
  );
}
