/**
 * OcrQrPage.tsx — Define Areas Builder
 *
 * Pipeline OMR gồm 3 bước:
 * 1. Vẽ box ROI (kéo chuột trên canvas) — xác định vùng crop
 * 2. Chọn Field Type + kích thước grid (rows, cols, semantic)
 * 3. Căn bubble grid: AutoFit (tự tính từ box) hoặc Pick tâm bubble (3 điểm)
 *
 * Pick Points calibrates selected area geometry (origin/gaps) mà KHÔNG thay box ROI.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Plus, Trash2, Download, Upload, Save,
  FileImage, RefreshCw, Crosshair, Info,
} from 'lucide-react';
import Button from '../components/common/Button';
import Card from '../components/common/Card';
import PageHeader from '../components/layout/PageHeader';
import { requestRaw } from '../services/apiClient';

// ── Types ─────────────────────────────────────────────────────────────────────

type SemanticType =
  | 'SBD' | 'CCCD' | 'MA_DE' | 'CA_THI' | 'MA_CTDT' | 'TU_CHON'
  | 'MCQ4' | 'TRUE_FALSE' | 'YES_NO';
type FieldType =
  | 'QTYPE_INT' | 'QTYPE_MCQ4' | 'QTYPE_MCQ5'
  | 'QTYPE_TRUE_FALSE' | 'QTYPE_YES_NO' | '';

interface AreaDef {
  key:              string;
  type:             'omr';
  label:            string;
  blockName:        string;
  semanticType:     SemanticType | '';
  fieldType:        FieldType;
  box:              [number, number, number, number]; // [x1,y1,x2,y2] page coords — ROI crop
  origin:           [number, number];                 // top-left of first bubble
  physicalRows:     number;
  physicalCols:     number;
  labelPrefix:      string;
  labelStart:       number;
  labelCount:       number;
  fieldLabels:      string;
  bubblesGap:       number;  // MCQ: x-gap A→B→C→D | INT: y-gap digit row
  labelsGap:        number;  // MCQ: y-gap row→row  | INT: x-gap col→col
  bubbleDimensions: [number, number];
  autoFit:          boolean;
  includeInAnswerKey:   boolean;
  excludeFromAnswerKey: boolean;
}

interface PreviewBubble {
  x: number; y: number; w: number; h: number;
  label: string; colIndex: number; rowIndex: number;
}

// ── Pick Points types ─────────────────────────────────────────────────────────

interface PickPoint { x: number; y: number; }

/**
 * Active pick calibration session.
 * targetAreaKey = the area whose bubble geometry will be updated (box is preserved).
 */
interface PickSession {
  targetAreaKey: string;
  fieldType: 'QTYPE_MCQ4' | 'QTYPE_INT';
  rows: number;
  cols: number;
  points: PickPoint[];
}

// ── Interaction state machine ─────────────────────────────────────────────────

type ResizeHandle = 'TL' | 'T' | 'TR' | 'L' | 'R' | 'BL' | 'B' | 'BR';

type Interaction =
  | { type: 'idle' }
  | { type: 'drawing'; x0: number; y0: number; x1: number; y1: number }
  | { type: 'moving';  areaKey: string; startX: number; startY: number; origBox: [number,number,number,number]; origOrigin: [number,number] }
  | { type: 'resizing'; areaKey: string; handle: ResizeHandle; startX: number; startY: number; origBox: [number,number,number,number] };

// ── Constants ─────────────────────────────────────────────────────────────────

const SEMANTIC_OPTIONS: { value: SemanticType | ''; label: string; fieldType: FieldType }[] = [
  { value: '',           label: 'Tùy chọn (không preset)',   fieldType: '' },
  { value: 'SBD',        label: 'Số báo danh (INT)',          fieldType: 'QTYPE_INT' },
  { value: 'CCCD',       label: 'CCCD (INT 12 cột)',          fieldType: 'QTYPE_INT' },
  { value: 'MA_DE',      label: 'Mã đề (INT 3 cột)',          fieldType: 'QTYPE_INT' },
  { value: 'CA_THI',     label: 'Ca thi (INT 2 cột)',         fieldType: 'QTYPE_INT' },
  { value: 'MA_CTDT',    label: 'Mã CTĐT (INT)',              fieldType: 'QTYPE_INT' },
  { value: 'TU_CHON',    label: 'Tùy chọn INT',               fieldType: 'QTYPE_INT' },
  { value: 'MCQ4',       label: 'Trắc nghiệm A/B/C/D',        fieldType: 'QTYPE_MCQ4' },
  { value: 'TRUE_FALSE', label: 'Đúng/Sai (T/F)',             fieldType: 'QTYPE_TRUE_FALSE' },
  { value: 'YES_NO',     label: 'Yes/No',                     fieldType: 'QTYPE_YES_NO' },
];

// Human-readable hints per semantic type
const SEMANTIC_HINTS: Partial<Record<SemanticType | '', string>> = {
  '':           'Tuỳ ý cấu hình field type và kích thước.',
  'SBD':        'INT · thường 4–8 cột chữ số (SBD 4 chữ → 4 cột).',
  'CCCD':       'INT · 12 cột chữ số.',
  'MA_DE':      'INT · 3 cột chữ số (mã đề 3 chữ).',
  'CA_THI':     'INT · 2 cột chữ số.',
  'MA_CTDT':    'INT · tuỳ số chữ số CTĐT.',
  'TU_CHON':    'INT · nhập số cột tay.',
  'MCQ4':       'MCQ4 · rows = số câu, cols = 4 (A/B/C/D).',
  'TRUE_FALSE': 'TRUE_FALSE · rows = số câu, cols = 2 (T/F).',
  'YES_NO':     'YES_NO · rows = số câu, cols = 2 (Y/N).',
};

interface SemanticPreset {
  fieldType: FieldType; labelPrefix: string;
  physicalRows: number; physicalCols: number; fieldLabels: string;
}
const SEMANTIC_PRESETS_CONFIG: Partial<Record<SemanticType, SemanticPreset>> = {
  SBD:        { fieldType: 'QTYPE_INT',        labelPrefix: 'sbd',     physicalRows: 10, physicalCols: 4,  fieldLabels: 'sbd1..4'      },
  CCCD:       { fieldType: 'QTYPE_INT',        labelPrefix: 'cccd',    physicalRows: 10, physicalCols: 12, fieldLabels: 'cccd1..12'    },
  MA_DE:      { fieldType: 'QTYPE_INT',        labelPrefix: 'ma_de',   physicalRows: 10, physicalCols: 3,  fieldLabels: 'ma_de1..3'    },
  CA_THI:     { fieldType: 'QTYPE_INT',        labelPrefix: 'ca_thi',  physicalRows: 10, physicalCols: 2,  fieldLabels: 'ca_thi1..2'   },
  MA_CTDT:    { fieldType: 'QTYPE_INT',        labelPrefix: 'ma_ctdt', physicalRows: 10, physicalCols: 2,  fieldLabels: 'ma_ctdt1..2'  },
  TU_CHON:    { fieldType: 'QTYPE_INT',        labelPrefix: 'tu_chon', physicalRows: 10, physicalCols: 2,  fieldLabels: 'tu_chon1..2'  },
  MCQ4:       { fieldType: 'QTYPE_MCQ4',       labelPrefix: 'q',       physicalRows: 10, physicalCols: 4,  fieldLabels: 'q1..10'       },
  TRUE_FALSE: { fieldType: 'QTYPE_TRUE_FALSE', labelPrefix: 'ds',      physicalRows: 10, physicalCols: 2,  fieldLabels: 'ds1..10'      },
  YES_NO:     { fieldType: 'QTYPE_YES_NO',     labelPrefix: 'yn',      physicalRows: 10, physicalCols: 2,  fieldLabels: 'yn1..10'      },
};

const DEFAULT_PAGE = { w: 1000, h: 1414 };
const DRAFT_KEY    = 'vju_define_areas_draft';
const MIN_BOX      = 20;

// ── Pick step guidance ────────────────────────────────────────────────────────

const PICK_STEPS_MCQ4 = [
  'Click 1/3 — A câu đầu: hàng câu đầu tiên, cột đáp án A',
  'Click 2/3 — D câu đầu: hàng câu đầu tiên, cột đáp án D (hoặc cột cuối)',
  'Click 3/3 — A câu cuối: hàng câu cuối cùng, cột đáp án A',
];
const PICK_STEPS_INT = [
  'Click 1/3 — Cột 1, số 0: cột đầu tiên, hàng chữ số 0',
  'Click 2/3 — Cột cuối, số 0: cột cuối cùng, hàng chữ số 0',
  'Click 3/3 — Cột 1, số 9: cột đầu tiên, hàng chữ số 9',
];

// ── Resize handle definitions ─────────────────────────────────────────────────

const HANDLE_KEYS: ResizeHandle[] = ['TL', 'T', 'TR', 'L', 'R', 'BL', 'B', 'BR'];
const HANDLE_STYLE: Record<ResizeHandle, React.CSSProperties> = {
  TL: { top: -5,  left: -5,                   cursor: 'nwse-resize' },
  T:  { top: -5,  left: 'calc(50% - 5px)',    cursor: 'ns-resize'   },
  TR: { top: -5,  right: -5,                  cursor: 'nesw-resize' },
  L:  { top: 'calc(50% - 5px)', left: -5,     cursor: 'ew-resize'   },
  R:  { top: 'calc(50% - 5px)', right: -5,    cursor: 'ew-resize'   },
  BL: { bottom: -5, left: -5,                 cursor: 'nesw-resize' },
  B:  { bottom: -5, left: 'calc(50% - 5px)',  cursor: 'ns-resize'   },
  BR: { bottom: -5, right: -5,                cursor: 'nwse-resize' },
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

function isIntFieldType(ft: FieldType) { return ft === 'QTYPE_INT'; }

function makeFieldLabels(prefix: string, start: number, count: number): string {
  if (count <= 1) return `${prefix}${start}`;
  return `${prefix}${start}..${prefix}${start + count - 1}`;
}

function getFieldTypeValues(ft: FieldType): string[] {
  switch (ft) {
    case 'QTYPE_INT':        return ['1','2','3','4','5','6','7','8','9','0'];
    case 'QTYPE_MCQ4':       return ['A','B','C','D'];
    case 'QTYPE_MCQ5':       return ['A','B','C','D','E'];
    case 'QTYPE_TRUE_FALSE': return ['T','F'];
    case 'QTYPE_YES_NO':     return ['Y','N'];
    default:                  return ['A','B','C','D'];
  }
}

function computeAutofitGeometry(area: AreaDef): {
  origin: [number, number]; bubbleDimensions: [number, number];
  bubblesGap: number; labelsGap: number;
} {
  const [bx1, by1, bx2, by2] = area.box;
  const boxW = Math.max(1, bx2 - bx1), boxH = Math.max(1, by2 - by1);
  const isInt = isIntFieldType(area.fieldType);
  const values = getFieldTypeValues(area.fieldType);
  const nRows = isInt ? values.length  : area.physicalRows;
  const nCols = isInt ? area.physicalCols : values.length;
  const bubbleW = Math.max(5, Math.floor((boxW / nCols) * 0.75));
  const bubbleH = Math.max(5, Math.floor((boxH / nRows) * 0.75));
  let bubblesGap: number, labelsGap: number;
  if (isInt) {
    bubblesGap = Math.max(0, Math.floor((boxH - bubbleH) / Math.max(1, nRows - 1)));
    labelsGap  = Math.max(0, Math.floor((boxW - bubbleW) / Math.max(1, nCols - 1)));
  } else {
    bubblesGap = Math.max(0, Math.floor((boxW - bubbleW) / Math.max(1, nCols - 1)));
    labelsGap  = Math.max(0, Math.floor((boxH - bubbleH) / Math.max(1, nRows - 1)));
  }
  return { origin: [bx1, by1], bubbleDimensions: [bubbleW, bubbleH], bubblesGap, labelsGap };
}

function computePreviewBubbles(area: AreaDef): PreviewBubble[] {
  const isInt  = isIntFieldType(area.fieldType);
  const values = getFieldTypeValues(area.fieldType);
  let ox: number, oy: number, bw: number, bh: number, bubblesGap: number, labelsGap: number;
  if (area.autoFit) {
    const geo = computeAutofitGeometry(area);
    [ox, oy] = geo.origin; [bw, bh] = geo.bubbleDimensions;
    bubblesGap = geo.bubblesGap; labelsGap = geo.labelsGap;
  } else {
    [ox, oy] = area.origin; [bw, bh] = area.bubbleDimensions;
    bubblesGap = area.bubblesGap; labelsGap = area.labelsGap;
  }
  const bubbles: PreviewBubble[] = [];
  if (isInt) {
    for (let c = 0; c < area.physicalCols; c++)
      for (let d = 0; d < values.length; d++)
        bubbles.push({ x: ox + c * labelsGap, y: oy + d * bubblesGap, w: bw, h: bh, label: values[d], colIndex: c, rowIndex: d });
  } else {
    for (let r = 0; r < area.physicalRows; r++)
      for (let o = 0; o < values.length; o++)
        bubbles.push({ x: ox + o * bubblesGap, y: oy + r * labelsGap, w: bw, h: bh, label: values[o], colIndex: o, rowIndex: r });
  }
  return bubbles;
}

function uid() { return Math.random().toString(36).slice(2, 9); }

function defaultArea(box: [number, number, number, number]): AreaDef {
  return {
    key: uid(), type: 'omr', label: 'OMR Block',
    blockName: `Block_${uid().slice(0, 4).toUpperCase()}`,
    semanticType: '', fieldType: 'QTYPE_MCQ4',
    box, origin: [box[0], box[1]],
    physicalRows: 10, physicalCols: 4,
    labelPrefix: 'q', labelStart: 1, labelCount: 10, fieldLabels: 'q1..10',
    bubblesGap: 60, labelsGap: 50, bubbleDimensions: [40, 30],
    autoFit: true, includeInAnswerKey: true, excludeFromAnswerKey: false,
  };
}

// ── Apply Pick Points calibration to an existing area ────────────────────────
//
// The ROI box is PRESERVED. Only the bubble geometry is updated:
//   origin, bubbleDimensions, bubblesGap, labelsGap, autoFit=false
//
// Coordinate convention: user clicks bubble *centers*.
//   origin (top-left of first bubble div) = click_center − bubbleSize/2
//
// MCQ4 horizontal layout (computePreviewBubbles for !isInt):
//   bubblesGap = x-gap between option cols  (A→B→C→D)
//   labelsGap  = y-gap between question rows
//   p1 = A câu đầu, p2 = D câu đầu, p3 = A câu cuối
//
// INT vertical layout (computePreviewBubbles for isInt):
//   bubblesGap = y-gap between digit rows   (0→1→…→9)
//   labelsGap  = x-gap between digit cols
//   p1 = cột1/số0, p2 = cộtLast/số0, p3 = cột1/số9

function applyPickToArea(area: AreaDef, session: PickSession): AreaDef {
  const { fieldType, rows, cols, points } = session;
  const [p1, p2, p3] = points;

  if (fieldType === 'QTYPE_MCQ4') {
    const colGap = cols > 1 ? (p2.x - p1.x) / (cols - 1) : 60;
    const rowGap = rows > 1 ? (p3.y - p1.y) / (rows - 1) : 50;
    const bw = Math.max(6, Math.round(Math.min(Math.abs(colGap), Math.abs(rowGap)) * 0.65));
    const bh = bw;
    const originX = Math.round(p1.x - bw / 2);
    const originY = Math.round(p1.y - bh / 2);
    return {
      ...area,
      fieldType: 'QTYPE_MCQ4',
      physicalRows: rows, physicalCols: cols,
      origin: [originX, originY],
      bubblesGap: Math.round(Math.abs(colGap)),
      labelsGap:  Math.round(Math.abs(rowGap)),
      bubbleDimensions: [bw, bh],
      autoFit: false,
      // box is intentionally preserved
    };
  } else {
    // QTYPE_INT
    const colGap = cols > 1 ? (p2.x - p1.x) / (cols - 1) : 60;
    const rowGap = (p3.y - p1.y) / 9; // 10 digits → 9 intervals
    const bw = Math.max(6, Math.round(Math.min(Math.abs(colGap), Math.abs(rowGap)) * 0.65));
    const bh = bw;
    const originX = Math.round(p1.x - bw / 2);
    const originY = Math.round(p1.y - bh / 2);
    return {
      ...area,
      fieldType: 'QTYPE_INT',
      physicalRows: 10, physicalCols: cols,
      origin: [originX, originY],
      bubblesGap: Math.round(Math.abs(rowGap)),
      labelsGap:  Math.round(Math.abs(colGap)),
      bubbleDimensions: [bw, bh],
      autoFit: false,
      // box is intentionally preserved
    };
  }
}

// ── Resize helper ─────────────────────────────────────────────────────────────

function applyResize(
  handle: ResizeHandle,
  origBox: [number,number,number,number],
  dx: number, dy: number, pageW: number, pageH: number,
): [number,number,number,number] {
  let [x1, y1, x2, y2] = origBox;
  if (handle.includes('L')) x1 = Math.max(0,     Math.min(x2 - MIN_BOX, x1 + dx));
  if (handle.includes('R')) x2 = Math.min(pageW, Math.max(x1 + MIN_BOX, x2 + dx));
  if (handle.includes('T')) y1 = Math.max(0,     Math.min(y2 - MIN_BOX, y1 + dy));
  if (handle.includes('B')) y2 = Math.min(pageH, Math.max(y1 + MIN_BOX, y2 + dy));
  return [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
}

// ── Pick point label helper ───────────────────────────────────────────────────

function getPickLabel(ft: 'QTYPE_MCQ4' | 'QTYPE_INT', idx: number): string {
  const labels = ft === 'QTYPE_MCQ4'
    ? ['P1 (A đầu)', 'P2 (D đầu)', 'P3 (A cuối)']
    : ['P1 (Cột 1, số 0)', 'P2 (Cột cuối, số 0)', 'P3 (Cột 1, số 9)'];
  return labels[idx] ?? `P${idx + 1}`;
}

// ── Area config panel ─────────────────────────────────────────────────────────

function AreaPanel({
  area, onChange, onDelete, onRefresh, onStartPick, onCopyJson, onExportSingle,
  pickActive, showBubbleDebug, onToggleDebug,
}: {
  area: AreaDef;
  onChange: (a: AreaDef) => void;
  onDelete: () => void;
  onRefresh: () => void;
  onStartPick: () => void;
  onCopyJson: () => void;
  onExportSingle: () => void;
  pickActive: boolean;
  showBubbleDebug: boolean;
  onToggleDebug: (v: boolean) => void;
}) {
  function set<K extends keyof AreaDef>(k: K, v: AreaDef[K]) { onChange({ ...area, [k]: v }); }

  const semanticHasPreset = !!SEMANTIC_OPTIONS.find(o => o.value === area.semanticType)?.fieldType;
  const isInt = isIntFieldType(area.fieldType);
  const hint  = SEMANTIC_HINTS[area.semanticType] ?? '';

  const inp: React.CSSProperties = {
    width: '100%', padding: '6px 10px', borderRadius: 7,
    border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'inherit', outline: 'none', background: '#fff',
  };
  const inpOff: React.CSSProperties = { ...inp, background: '#F3F4F6', color: '#9CA3AF', cursor: 'not-allowed' };
  const lbl: React.CSSProperties  = { fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 3 };
  const row: React.CSSProperties  = { marginBottom: 10 };
  const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 };

  // Row/col labels differ by field type
  const rowLabel = isInt  ? 'Digit Rows (luôn 10)' : 'Số câu (rows)';
  const colLabel = isInt  ? 'Số cột chữ số'         : `Số đáp án${area.fieldType === 'QTYPE_MCQ4' ? ' (luôn 4)' : ''}`;

  return (
    <div style={{ background: '#F9FAFB', border: '2px solid #C8102E', borderRadius: 10, overflow: 'hidden' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#FFF5F5', borderBottom: '1px solid #FECACA' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#1E1E1E', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
          {area.blockName || '(chưa đặt tên)'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 10, background: '#FEF2F2', color: '#C8102E', borderRadius: 5, padding: '2px 6px', fontWeight: 700 }}>
            {area.fieldType || 'custom'}
          </span>
          <button onClick={e => { e.stopPropagation(); onDelete(); }}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9CA3AF', padding: 2 }}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div style={{ padding: '10px 12px' }}>

        {/* ── Bước 1: ROI info (read-only) ── */}
        <div style={{ marginBottom: 12, padding: '6px 9px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 7 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#1D4ED8', marginBottom: 2 }}>Bước 1 ✓ — ROI Box (vùng crop)</div>
          <div style={{ fontSize: 10, color: '#374151', fontFamily: 'monospace' }}>
            [{area.box.map(v => Math.round(v)).join(', ')}]
            <span style={{ marginLeft: 8, color: '#6B7280' }}>
              {Math.round(area.box[2]-area.box[0])} × {Math.round(area.box[3]-area.box[1])} px
            </span>
          </div>
          <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>Kéo body=move · Kéo handle=resize</div>
        </div>

        {/* ── Bước 2: Field config ── */}
        <div style={{ fontSize: 10, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Bước 2 — Loại Field &amp; Kích thước
        </div>

        {/* Block name */}
        <div style={row}>
          <div style={lbl}>Block Name *</div>
          <input style={inp} value={area.blockName} onChange={e => set('blockName', e.target.value)} placeholder="VD: SoBaoDanh" />
        </div>

        {/* Semantic + fieldType */}
        <div style={grid2}>
          <div>
            <div style={lbl}>Semantic Type</div>
            <select style={inp} value={area.semanticType}
              onChange={e => {
                const st = e.target.value as SemanticType | '';
                const preset = SEMANTIC_PRESETS_CONFIG[st as SemanticType];
                if (preset) {
                  onChange({
                    ...area, semanticType: st,
                    fieldType: preset.fieldType, labelPrefix: preset.labelPrefix,
                    physicalRows: preset.physicalRows, physicalCols: preset.physicalCols,
                    fieldLabels: preset.fieldLabels,
                    labelCount: isIntFieldType(preset.fieldType) ? preset.physicalCols : preset.physicalRows,
                  });
                } else {
                  onChange({ ...area, semanticType: st });
                }
              }}>
              {SEMANTIC_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <div style={lbl}>Field Type</div>
            <select style={inp} value={area.fieldType}
              onChange={e => set('fieldType', e.target.value as FieldType)}
              disabled={semanticHasPreset && !!area.semanticType}>
              {['QTYPE_MCQ4','QTYPE_MCQ5','QTYPE_INT','QTYPE_TRUE_FALSE','QTYPE_YES_NO',''].map(t => (
                <option key={t} value={t}>{t || 'custom'}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Semantic hint */}
        {hint && (
          <div style={{ fontSize: 10, color: '#6B7280', background: '#F3F4F6', borderRadius: 6, padding: '4px 8px', marginBottom: 10, display: 'flex', gap: 5, alignItems: 'flex-start' }}>
            <Info size={10} style={{ flexShrink: 0, marginTop: 1 }} />
            {hint}
          </div>
        )}

        {/* Label prefix + start */}
        <div style={grid2}>
          <div>
            <div style={lbl}>Label Prefix</div>
            <input style={inp} value={area.labelPrefix}
              onChange={e => {
                const p = e.target.value;
                const count = isInt ? area.physicalCols : area.physicalRows;
                onChange({ ...area, labelPrefix: p, fieldLabels: makeFieldLabels(p, area.labelStart, count) });
              }} placeholder="q" />
          </div>
          <div>
            <div style={lbl}>Label Start</div>
            <input style={inp} type="number" min={1} value={area.labelStart}
              onChange={e => set('labelStart', parseInt(e.target.value) || 1)} />
          </div>
        </div>

        {/* fieldLabels */}
        <div style={row}>
          <div style={lbl}>{isInt ? 'Column Labels (nhãn cột)' : 'Field Labels (nhãn câu)'}</div>
          <input style={inp} value={area.fieldLabels}
            onChange={e => set('fieldLabels', e.target.value)}
            placeholder={isInt ? makeFieldLabels(area.labelPrefix, area.labelStart, area.physicalCols) : 'q1..10'} />
        </div>

        {/* Rows + Cols */}
        <div style={grid2}>
          <div>
            <div style={lbl}>{rowLabel}</div>
            <input style={isInt ? inpOff : inp} type="number" min={1} value={area.physicalRows}
              disabled={isInt}
              onChange={e => {
                const rows = parseInt(e.target.value) || 1;
                onChange({ ...area, physicalRows: rows, ...(!isInt ? { fieldLabels: makeFieldLabels(area.labelPrefix, area.labelStart, rows) } : {}) });
              }} />
          </div>
          <div>
            <div style={lbl}>{colLabel}</div>
            <input style={inp} type="number" min={1} value={area.physicalCols}
              onChange={e => {
                const cols = parseInt(e.target.value) || 1;
                onChange({ ...area, physicalCols: cols, ...(isInt ? { fieldLabels: makeFieldLabels(area.labelPrefix, area.labelStart, cols) } : {}) });
              }} />
            {isInt && (
              <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>
                CCCD=12, SBD=8 hoặc 4, MĐ=3, CT=2
              </div>
            )}
          </div>
        </div>

        {/* ── Bước 3: Căn bubble grid ── */}
        <div style={{ fontSize: 10, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Bước 3 — Căn Bubble Grid
        </div>

        {/* AutoFit */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <input type="checkbox" id={`af-${area.key}`} checked={area.autoFit}
            onChange={e => set('autoFit', e.target.checked)} />
          <label htmlFor={`af-${area.key}`} style={{ fontSize: 12, color: '#374151', cursor: 'pointer' }}>
            AutoFit — tự tính geometry từ ROI box
          </label>
        </div>
        {area.autoFit && (
          <div style={{ fontSize: 10, color: '#B45309', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '4px 8px', marginBottom: 10 }}>
            ⚠ AutoFit bật — tắt để chỉnh tay hoặc dùng Pick tâm bubble
          </div>
        )}

        {/* Manual bubble dims / gaps (disabled when autoFit) */}
        <div style={grid2}>
          <div>
            <div style={lbl}>Bubble W × H</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input style={{ ...(area.autoFit ? inpOff : inp), width: '50%' }} type="number" min={1}
                disabled={area.autoFit}
                value={area.autoFit ? Math.round(computeAutofitGeometry(area).bubbleDimensions[0]) : area.bubbleDimensions[0]}
                onChange={e => onChange({ ...area, autoFit: false, bubbleDimensions: [parseInt(e.target.value) || 20, area.bubbleDimensions[1]] })} />
              <input style={{ ...(area.autoFit ? inpOff : inp), width: '50%' }} type="number" min={1}
                disabled={area.autoFit}
                value={area.autoFit ? Math.round(computeAutofitGeometry(area).bubbleDimensions[1]) : area.bubbleDimensions[1]}
                onChange={e => onChange({ ...area, autoFit: false, bubbleDimensions: [area.bubbleDimensions[0], parseInt(e.target.value) || 20] })} />
            </div>
          </div>
          <div>
            <div style={lbl}>{isInt ? 'DigitGap / ColGap' : 'OptionGap / RowGap'}</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input style={{ ...(area.autoFit ? inpOff : inp), width: '50%' }} type="number" min={0}
                disabled={area.autoFit}
                value={area.autoFit ? Math.round(computeAutofitGeometry(area).bubblesGap) : area.bubblesGap}
                onChange={e => onChange({ ...area, autoFit: false, bubblesGap: parseInt(e.target.value) || 0 })} />
              <input style={{ ...(area.autoFit ? inpOff : inp), width: '50%' }} type="number" min={0}
                disabled={area.autoFit}
                value={area.autoFit ? Math.round(computeAutofitGeometry(area).labelsGap) : area.labelsGap}
                onChange={e => onChange({ ...area, autoFit: false, labelsGap: parseInt(e.target.value) || 0 })} />
            </div>
            <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>
              {isInt ? 'bubblesGap=dọc (digit), labelsGap=ngang (cột)' : 'bubblesGap=ngang A/B/C/D, labelsGap=dọc câu'}
            </div>
          </div>
        </div>

        {/* Pick tâm bubble button */}
        <button
          onClick={onStartPick}
          disabled={pickActive}
          style={{
            width: '100%', padding: '7px 0', borderRadius: 8, fontSize: 11, fontWeight: 700,
            border: `1.5px solid ${pickActive ? '#E5E7EB' : '#7C3AED'}`,
            color: pickActive ? '#9CA3AF' : '#7C3AED',
            background: pickActive ? '#F9FAFB' : '#F5F3FF',
            cursor: pickActive ? 'default' : 'pointer',
            fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            marginBottom: 10,
          }}>
          <Crosshair size={12} />
          {pickActive ? 'Đang pick tâm bubble…' : 'Pick tâm bubble (3 điểm)'}
        </button>

        {/* Calibration result — shown when manual geometry is set */}
        {!area.autoFit && area.bubblesGap > 0 && (
          <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#065F46', marginBottom: 6 }}>Calibration Result</div>
            <div style={{ fontSize: 10, color: '#374151', fontFamily: 'monospace', lineHeight: 1.9 }}>
              <div>Origin: [{area.origin.map(v => Math.round(v)).join(', ')}]</div>
              <div>Rows: {area.physicalRows} | Cols: {area.physicalCols}</div>
              <div>{isInt ? 'RowGap' : 'OptionGap'}: {area.bubblesGap} | {isInt ? 'ColGap' : 'RowGap'}: {area.labelsGap}</div>
              <div>Bubble: {area.bubbleDimensions[0]} × {area.bubbleDimensions[1]}</div>
              <div>Box: [{area.box.map(v => Math.round(v)).join(', ')}]</div>
            </div>
            <div style={{ display: 'flex', gap: 5, marginTop: 8, flexWrap: 'wrap' }}>
              <button onClick={onStartPick} disabled={pickActive} style={{ flex: 1, padding: '5px 0', borderRadius: 7, fontSize: 10, fontWeight: 700, border: '1.5px solid #7C3AED', color: '#7C3AED', background: '#F5F3FF', cursor: pickActive ? 'default' : 'pointer', fontFamily: 'inherit' }}>Pick lại</button>
              <button onClick={onCopyJson} style={{ flex: 1, padding: '5px 0', borderRadius: 7, fontSize: 10, fontWeight: 700, border: '1.5px solid #0284C7', color: '#0284C7', background: '#F0F9FF', cursor: 'pointer', fontFamily: 'inherit' }}>Copy JSON</button>
              <button onClick={onExportSingle} style={{ flex: 1, padding: '5px 0', borderRadius: 7, fontSize: 10, fontWeight: 700, border: '1.5px solid #059669', color: '#065F46', background: '#ECFDF5', cursor: 'pointer', fontFamily: 'inherit' }}>Export</button>
            </div>
          </div>
        )}

        {/* Debug bubble toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <input type="checkbox" id={`dbg-${area.key}`} checked={showBubbleDebug}
            onChange={e => onToggleDebug(e.target.checked)} />
          <label htmlFor={`dbg-${area.key}`} style={{ fontSize: 12, color: '#374151', cursor: 'pointer' }}>
            Hiện vòng bubble debug (che phiếu)
          </label>
        </div>

        {/* Include in answer key */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <input type="checkbox" id={`incl-${area.key}`} checked={area.includeInAnswerKey}
            onChange={e => set('includeInAnswerKey', e.target.checked)} />
          <label htmlFor={`incl-${area.key}`} style={{ fontSize: 12, color: '#374151', cursor: 'pointer' }}>
            Bao gồm trong answer key
          </label>
        </div>

        {/* Refresh preview */}
        <button onClick={onRefresh} style={{
          width: '100%', padding: '6px 0', borderRadius: 7, fontSize: 11, fontWeight: 700,
          border: '1.5px solid #059669', color: '#065F46', background: '#D1FAE5',
          cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        }}>
          <RefreshCw size={11} /> Refresh preview
        </button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OcrQrPage() {
  const [imgSrc,          setImgSrc]          = useState<string | null>(null);
  const [areas,           setAreas]           = useState<AreaDef[]>([]);
  const [selectedKey,     setSelectedKey]     = useState<string | null>(null);
  const [interaction,     setInteraction]     = useState<Interaction>({ type: 'idle' });
  const [pickSession,     setPickSession]     = useState<PickSession | null>(null);
  const [showBubbleDebug, setShowBubbleDebug] = useState(false);

  const [bubblePreviews, setBubblePreviews] = useState<Record<string, PreviewBubble[]>>({});
  const [saving,       setSaving]       = useState(false);
  const [templateName, setTemplateName] = useState('Custom Template');
  const [saveMsg,      setSaveMsg]      = useState('');
  const [pageDims,     setPageDims]     = useState<[number, number]>([DEFAULT_PAGE.w, DEFAULT_PAGE.h]);

  const canvasRef    = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importRef    = useRef<HTMLInputElement>(null);

  // ── Cancel pick session if user selects a different area ─────────────────
  useEffect(() => {
    if (pickSession && selectedKey !== pickSession.targetAreaKey) {
      setPickSession(null);
    }
  }, [selectedKey, pickSession]);

  // ── Restore draft ────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw) as { areas?: AreaDef[]; templateName?: string; pageDims?: [number,number] };
        if (draft.areas && Array.isArray(draft.areas)) {
          setAreas(draft.areas);
          const previews: Record<string, PreviewBubble[]> = {};
          for (const a of draft.areas) previews[a.key] = computePreviewBubbles(a);
          setBubblePreviews(previews);
        }
        if (draft.templateName) setTemplateName(draft.templateName);
        if (draft.pageDims)     setPageDims(draft.pageDims);
      }
    } catch { /* ignore */ }
  }, []);

  // ── Persist draft ────────────────────────────────────────────────────────
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ areas, templateName, pageDims })); }
    catch { /* ignore */ }
  }, [areas, templateName, pageDims]);

  // ── Canvas coordinate conversion ─────────────────────────────────────────
  const toPageCoords = useCallback((clientX: number, clientY: number): [number, number] => {
    if (!canvasRef.current) return [0, 0];
    const rect = canvasRef.current.getBoundingClientRect();
    return [
      Math.max(0, Math.min(pageDims[0], (clientX - rect.left) * (pageDims[0] / rect.width))),
      Math.max(0, Math.min(pageDims[1], (clientY - rect.top)  * (pageDims[1] / rect.height))),
    ];
  }, [pageDims]);

  const boxToStyle = (box: [number,number,number,number]) => ({
    left:   `${(box[0] / pageDims[0]) * 100}%`,
    top:    `${(box[1] / pageDims[1]) * 100}%`,
    width:  `${((box[2] - box[0]) / pageDims[0]) * 100}%`,
    height: `${((box[3] - box[1]) / pageDims[1]) * 100}%`,
  });
  const bubbleToStyle = (b: PreviewBubble) => ({
    left:   `${(b.x / pageDims[0]) * 100}%`,
    top:    `${(b.y / pageDims[1]) * 100}%`,
    width:  `${(b.w / pageDims[0]) * 100}%`,
    height: `${(b.h / pageDims[1]) * 100}%`,
  });

  // ── Pick session helpers ──────────────────────────────────────────────────

  /** Start calibration pick for the currently selected area. */
  function startPickSession() {
    const area = areas.find(a => a.key === selectedKey);
    if (!area) {
      alert('Hãy vẽ vùng ROI trước, sau đó chọn area và pick tâm bubble để căn grid.');
      return;
    }
    const ft: 'QTYPE_MCQ4' | 'QTYPE_INT' =
      area.fieldType === 'QTYPE_INT' ? 'QTYPE_INT' : 'QTYPE_MCQ4';
    setPickSession({
      targetAreaKey: area.key,
      fieldType: ft,
      rows: ft === 'QTYPE_MCQ4' ? area.physicalRows : 10,
      cols: area.physicalCols,
      points: [],
    });
    setInteraction({ type: 'idle' });
  }

  function cancelPickSession() { setPickSession(null); }
  function resetPickSession()  { if (pickSession) setPickSession({ ...pickSession, points: [] }); }

  /** Register one pick click; on 3rd point apply calibration to existing area. */
  function commitPickPoint(px: number, py: number) {
    if (!pickSession) return;
    const newPoints: PickPoint[] = [...pickSession.points, { x: Math.round(px), y: Math.round(py) }];

    if (newPoints.length >= 3) {
      const area = areas.find(a => a.key === pickSession.targetAreaKey);
      if (area) {
        const updated = applyPickToArea(area, { ...pickSession, points: newPoints });
        setAreas(prev => prev.map(a => a.key === updated.key ? updated : a));
        setBubblePreviews(prev => ({ ...prev, [updated.key]: computePreviewBubbles(updated) }));
        setSelectedKey(updated.key);
      }
      setPickSession(null);
    } else {
      setPickSession({ ...pickSession, points: newPoints });
    }
  }

  // ── Mouse handlers ────────────────────────────────────────────────────────

  function onCanvasMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const [px, py] = toPageCoords(e.clientX, e.clientY);

    if (pickSession) {
      commitPickPoint(px, py);
      e.preventDefault();
      return;
    }

    setSelectedKey(null);
    setInteraction({ type: 'drawing', x0: px, y0: py, x1: px, y1: py });
    e.preventDefault();
  }

  function onAreaMouseDown(e: React.MouseEvent, area: AreaDef) {
    if (e.button !== 0) return;

    // During pick, let the event bubble up to canvas (don't stop propagation)
    if (pickSession) return;

    e.stopPropagation();
    setSelectedKey(area.key);
    const [px, py] = toPageCoords(e.clientX, e.clientY);
    setInteraction({
      type: 'moving', areaKey: area.key,
      startX: px, startY: py,
      origBox: [...area.box] as [number,number,number,number],
      origOrigin: [...area.origin] as [number,number],
    });
    e.preventDefault();
  }

  function onHandleMouseDown(e: React.MouseEvent, area: AreaDef, handle: ResizeHandle) {
    if (e.button !== 0) return;
    if (pickSession) return; // ignore handles during pick
    e.stopPropagation();
    const [px, py] = toPageCoords(e.clientX, e.clientY);
    setInteraction({
      type: 'resizing', areaKey: area.key, handle,
      startX: px, startY: py,
      origBox: [...area.box] as [number,number,number,number],
    });
    e.preventDefault();
  }

  function onMouseMove(e: React.MouseEvent) {
    if (interaction.type === 'idle') return;
    const [px, py] = toPageCoords(e.clientX, e.clientY);

    if (interaction.type === 'drawing') {
      setInteraction(prev => prev.type === 'drawing' ? { ...prev, x1: px, y1: py } : prev);
      return;
    }
    if (interaction.type === 'moving') {
      const { areaKey, startX, startY, origBox, origOrigin } = interaction;
      const dx = px - startX, dy = py - startY;
      const bw = origBox[2] - origBox[0], bh = origBox[3] - origBox[1];
      const newX1 = Math.max(0, Math.min(pageDims[0] - bw, origBox[0] + dx));
      const newY1 = Math.max(0, Math.min(pageDims[1] - bh, origBox[1] + dy));
      const newBox: [number,number,number,number] = [Math.round(newX1), Math.round(newY1), Math.round(newX1+bw), Math.round(newY1+bh)];
      const newOrigin: [number,number] = [Math.round(origOrigin[0]+dx), Math.round(origOrigin[1]+dy)];
      setAreas(prev => prev.map(a => {
        if (a.key !== areaKey) return a;
        const updated = { ...a, box: newBox, origin: newOrigin };
        setBubblePreviews(p => ({ ...p, [areaKey]: computePreviewBubbles(updated) }));
        return updated;
      }));
      return;
    }
    if (interaction.type === 'resizing') {
      const { areaKey, handle, startX, startY, origBox } = interaction;
      const newBox = applyResize(handle, origBox, px - startX, py - startY, pageDims[0], pageDims[1]);
      setAreas(prev => prev.map(a => {
        if (a.key !== areaKey) return a;
        const updated = { ...a, box: newBox };
        setBubblePreviews(p => ({ ...p, [areaKey]: computePreviewBubbles(updated) }));
        return updated;
      }));
    }
  }

  function onMouseUp() {
    if (interaction.type === 'drawing') {
      const { x0, y0, x1, y1 } = interaction;
      const nx1 = Math.min(x0,x1), ny1 = Math.min(y0,y1);
      const nx2 = Math.max(x0,x1), ny2 = Math.max(y0,y1);
      if (nx2 - nx1 > 10 && ny2 - ny1 > 10) {
        const box: [number,number,number,number] = [Math.round(nx1), Math.round(ny1), Math.round(nx2), Math.round(ny2)];
        const area = defaultArea(box);
        setAreas(prev => [...prev, area]);
        setSelectedKey(area.key);
        setBubblePreviews(prev => ({ ...prev, [area.key]: computePreviewBubbles(area) }));
      }
    }
    setInteraction({ type: 'idle' });
  }

  // ── Image upload ──────────────────────────────────────────────────────────
  async function handleImageUpload(file: File) {
    if (file.type === 'application/pdf') {
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await requestRaw('/api/v1/custom-forms/pdf-preview', { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json() as { image?: string; mime?: string };
          if (data.image) { setImgSrc(`data:${data.mime ?? 'image/png'};base64,${data.image}`); return; }
        }
      } catch { /* fallback */ }
    }
    setImgSrc(URL.createObjectURL(file));
  }

  // ── Area API payload ──────────────────────────────────────────────────────
  function areaToApiPayload(a: AreaDef) {
    const isInt = isIntFieldType(a.fieldType);
    const labelCount = isInt ? a.physicalCols : a.physicalRows;
    const fieldLabels = makeFieldLabels(a.labelPrefix, a.labelStart, labelCount);
    const geo = a.autoFit
      ? computeAutofitGeometry(a)
      : { origin: a.origin, bubbleDimensions: a.bubbleDimensions, bubblesGap: a.bubblesGap, labelsGap: a.labelsGap };
    return {
      type: a.type, key: a.key, blockName: a.blockName,
      semanticType: a.semanticType || undefined,
      fieldType:    a.fieldType    || undefined,
      box: a.box, origin: geo.origin,
      physicalRows: a.physicalRows, physicalCols: a.physicalCols,
      labelPrefix: a.labelPrefix, labelStart: a.labelStart, fieldLabels,
      bubblesGap: geo.bubblesGap, labelsGap: geo.labelsGap,
      bubbleDimensions: geo.bubbleDimensions,
      autoFit: a.autoFit,
      includeInAnswerKey: a.includeInAnswerKey,
      excludeFromAnswerKey: a.excludeFromAnswerKey,
    };
  }

  // ── Save template ─────────────────────────────────────────────────────────
  async function saveTemplate() {
    if (!areas.length)       { alert('Chưa có area nào!'); return; }
    if (!templateName.trim()) { alert('Vui lòng nhập tên template'); return; }
    setSaving(true); setSaveMsg('');
    try {
      const res = await requestRaw('/api/v1/custom-forms/compile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: templateName, pageDimensions: pageDims, areas: areas.map(areaToApiPayload), use_crop_on_markers: false }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { detail?: unknown };
        const d = err.detail;
        if (d && typeof d === 'object' && 'errors' in d)
          alert('Compile lỗi:\n' + (d as { errors: string[] }).errors.join('\n'));
        else alert(`Lỗi: ${typeof d === 'string' ? d : JSON.stringify(d)}`);
        return;
      }
      const data = await res.json() as { id: number; name: string };
      setSaveMsg(`✓ Đã lưu template "${data.name}" (id=${data.id})`);
    } catch (err) { alert(`Lưu lỗi: ${String(err)}`); }
    finally { setSaving(false); }
  }

  // ── Import / Export ───────────────────────────────────────────────────────
  function exportAreas() {
    const blob = new Blob([JSON.stringify(areas.map(areaToApiPayload), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${templateName.replace(/\s+/g, '_')}_areas.json`;
    a.click(); URL.revokeObjectURL(url);
  }
  function importAreas(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        if (!Array.isArray(data)) { alert('File phải là JSON array'); return; }
        const imported: AreaDef[] = data.map((a: Partial<AreaDef>) => ({ ...defaultArea(a.box ?? [0,0,100,100]), ...a, key: uid() }));
        setAreas(imported);
        const previews: Record<string, PreviewBubble[]> = {};
        for (const a of imported) previews[a.key] = computePreviewBubbles(a);
        setBubblePreviews(previews);
        setSaveMsg(`✓ Đã import ${imported.length} areas`);
      } catch { alert('File JSON không hợp lệ'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ── Copy / Export single area ─────────────────────────────────────────────
  function copyAreaJson(area: AreaDef) {
    navigator.clipboard.writeText(JSON.stringify(areaToApiPayload(area), null, 2))
      .catch(() => alert('Không thể copy — thử Export JSON.'));
  }
  function exportSingleArea(area: AreaDef) {
    const blob = new Blob([JSON.stringify([areaToApiPayload(area)], null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${area.blockName || 'area'}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const canvasCursor: React.CSSProperties['cursor'] =
    pickSession ? 'crosshair' :
    interaction.type === 'drawing' ? 'crosshair' :
    interaction.type === 'moving'  ? 'grabbing'  : 'crosshair';

  const drawRect = interaction.type === 'drawing' ? {
    left:   `${(Math.min(interaction.x0, interaction.x1) / pageDims[0]) * 100}%`,
    top:    `${(Math.min(interaction.y0, interaction.y1) / pageDims[1]) * 100}%`,
    width:  `${(Math.abs(interaction.x1 - interaction.x0) / pageDims[0]) * 100}%`,
    height: `${(Math.abs(interaction.y1 - interaction.y0) / pageDims[1]) * 100}%`,
  } : null;

  const selectedArea = areas.find(a => a.key === selectedKey) ?? null;
  const pickSteps = pickSession?.fieldType === 'QTYPE_INT' ? PICK_STEPS_INT : PICK_STEPS_MCQ4;
  const currentPickStep = pickSession ? (pickSteps[pickSession.points.length] ?? null) : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title="Define Areas"
        subtitle="Vẽ ROI → chọn field type → căn bubble (AutoFit hoặc Pick)"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" icon={<Upload size={13} />} variant="secondary" onClick={() => importRef.current?.click()}>Import JSON</Button>
            <Button size="sm" icon={<Download size={13} />} variant="secondary" onClick={exportAreas}>Export JSON</Button>
            <Button size="sm" icon={<Save size={13} />} onClick={saveTemplate} disabled={saving}>
              {saving ? 'Đang lưu…' : 'Save Template'}
            </Button>
          </div>
        }
      />

      <input ref={importRef} type="file" accept=".json" style={{ display: 'none' }} onChange={importAreas} />

      <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>

        {/* ─ Top bar ── */}
        <Card style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 200px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Tên template</div>
              <input value={templateName} onChange={e => setTemplateName(e.target.value)}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1.5px solid #E5E7EB', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
                placeholder="VD: VJU Custom 40 câu" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['Page W', 'Page H'] as const).map((t, i) => (
                <div key={t}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>{t}</div>
                  <input type="number" value={pageDims[i]} min={100} max={9999}
                    onChange={e => { const v = parseInt(e.target.value)||(i===0?1000:1414); setPageDims(d => i===0?[v,d[1]]:[d[0],v]); }}
                    style={{ width: 80, padding: '7px 8px', borderRadius: 7, border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
                </div>
              ))}
            </div>
            <Button size="sm" icon={<FileImage size={13} />} variant="secondary" onClick={() => fileInputRef.current?.click()}>
              Upload ảnh/PDF
            </Button>
            <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); e.target.value = ''; }} />
          </div>
          {saveMsg && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#065F46', background: '#D1FAE5', padding: '6px 10px', borderRadius: 7 }}>{saveMsg}</div>
          )}
        </Card>

        {/* ─ Canvas + right panel ── */}
        <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>

          {/* ─── Canvas ── */}
          <Card style={{ flex: '1 1 0', padding: 0, overflow: 'hidden', position: 'relative', minHeight: 500 }}>
            <div
              ref={canvasRef}
              onMouseDown={onCanvasMouseDown} onMouseMove={onMouseMove}
              onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
              style={{
                position: 'relative', width: '100%',
                paddingBottom: `${(pageDims[1] / pageDims[0]) * 100}%`,
                cursor: canvasCursor, userSelect: 'none',
                background: '#CBD5E1', overflow: 'hidden',
              }}
            >
              {/* Sheet image */}
              {imgSrc ? (
                <img src={imgSrc} alt="sheet"
                  onLoad={e => { const img=e.currentTarget; if(img.naturalWidth>0) setPageDims([img.naturalWidth, img.naturalHeight]); }}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none' }}
                />
              ) : (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: '#94A3B8' }}>
                  <FileImage size={48} style={{ opacity: 0.3, marginBottom: 10 }} />
                  <div style={{ fontSize: 12 }}>Upload ảnh phiếu để bắt đầu kéo vùng ROI</div>
                </div>
              )}

              {/* Pick step overlay */}
              {pickSession && currentPickStep && (
                <div style={{
                  position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
                  background: 'rgba(124,58,237,0.92)', color: '#fff',
                  padding: '6px 14px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                  zIndex: 40, pointerEvents: 'none', whiteSpace: 'nowrap',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                }}>
                  <Crosshair size={11} style={{ display: 'inline', marginRight: 5, verticalAlign: 'middle' }} />
                  {currentPickStep}
                </div>
              )}

              {/* Bubble overlay — small coordinate crosshairs (default) or debug ellipses */}
              {selectedKey && (() => {
                const bubbles = bubblePreviews[selectedKey];
                if (!bubbles?.length) return null;
                return (
                  <svg
                    viewBox={`0 0 ${pageDims[0]} ${pageDims[1]}`}
                    preserveAspectRatio="none"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 3 }}
                  >
                    {showBubbleDebug
                      ? bubbles.map((b, i) => (
                          <ellipse key={i}
                            cx={b.x + b.w / 2} cy={b.y + b.h / 2}
                            rx={b.w / 2} ry={b.h / 2}
                            fill="rgba(200,16,46,0.15)"
                            stroke="rgba(200,16,46,0.8)" strokeWidth={1.5}
                          />
                        ))
                      : bubbles.map((b, i) => {
                          const cx = b.x + b.w / 2;
                          const cy = b.y + b.h / 2;
                          return (
                            <g key={i}>
                              <line x1={cx - 6} y1={cy} x2={cx + 6} y2={cy} stroke="#C8102E" strokeWidth={1.5} opacity={0.7} />
                              <line x1={cx} y1={cy - 6} x2={cx} y2={cy + 6} stroke="#C8102E" strokeWidth={1.5} opacity={0.7} />
                            </g>
                          );
                        })
                    }
                  </svg>
                );
              })()}

              {/* Area ROI rectangles */}
              {areas.map(a => {
                const isSel = a.key === selectedKey;
                return (
                  <div key={a.key}
                    onMouseDown={e => onAreaMouseDown(e, a)}
                    style={{
                      position: 'absolute', ...boxToStyle(a.box),
                      border: isSel ? '2px solid #C8102E' : '1.5px solid rgba(100,116,139,0.45)',
                      background: isSel ? 'transparent' : 'rgba(100,116,139,0.04)',
                      boxSizing: 'border-box',
                      cursor: pickSession ? 'crosshair' : (interaction.type==='moving' && interaction.areaKey===a.key ? 'grabbing' : 'grab'),
                      zIndex: isSel ? 10 : 5,
                    }}
                  >
                    {/* Label chip */}
                    <div style={{
                      position: 'absolute', top: 0, left: 0,
                      background: isSel ? '#C8102E' : 'rgba(100,116,139,0.65)',
                      color: '#fff', fontSize: 9, fontWeight: 700,
                      padding: '1px 5px', borderRadius: '0 0 4px 0',
                      maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      pointerEvents: 'none',
                    }}>
                      {a.blockName}
                    </div>

                    {/* 8 resize handles */}
                    {isSel && !pickSession && HANDLE_KEYS.map(h => (
                      <div key={h} onMouseDown={e => onHandleMouseDown(e, a, h)}
                        style={{
                          position: 'absolute', width: 10, height: 10,
                          background: '#fff', border: '2px solid #C8102E',
                          borderRadius: 2, boxSizing: 'border-box', zIndex: 20,
                          ...HANDLE_STYLE[h],
                        }}
                      />
                    ))}
                  </div>
                );
              })}

              {/* Drawing rect */}
              {drawRect && (
                <div style={{
                  position: 'absolute', ...drawRect,
                  border: '2px dashed #C8102E', background: 'rgba(200,16,46,0.06)',
                  boxSizing: 'border-box', pointerEvents: 'none', zIndex: 20,
                }} />
              )}

              {/* Pick point markers + crosshair lines (SVG, labeled) */}
              {pickSession && pickSession.points.length > 0 && (
                <svg
                  viewBox={`0 0 ${pageDims[0]} ${pageDims[1]}`}
                  preserveAspectRatio="none"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 35 }}
                >
                  {pickSession.points.map((pt, i) => (
                    <g key={i}>
                      {/* Full-canvas crosshair */}
                      <line x1={0} y1={pt.y} x2={pageDims[0]} y2={pt.y} stroke="rgba(124,58,237,0.25)" strokeWidth={2} />
                      <line x1={pt.x} y1={0} x2={pt.x} y2={pageDims[1]} stroke="rgba(124,58,237,0.25)" strokeWidth={2} />
                      {/* Marker ring */}
                      <circle cx={pt.x} cy={pt.y} r={14} fill="#7C3AED" stroke="white" strokeWidth={2.5} />
                      {/* Number */}
                      <text x={pt.x} y={pt.y} textAnchor="middle" dominantBaseline="central" fontSize={18} fill="white" fontWeight="bold">{i + 1}</text>
                      {/* Semantic label */}
                      <text x={pt.x + 18} y={pt.y} dominantBaseline="central" fontSize={22} fill="#7C3AED" fontWeight="bold"
                        style={{ paintOrder: 'stroke', stroke: 'white', strokeWidth: 4, strokeLinejoin: 'round' }}>
                        {getPickLabel(pickSession.fieldType, i)}
                      </text>
                    </g>
                  ))}
                </svg>
              )}
            </div>

            {/* Footer */}
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              padding: '4px 10px', background: 'rgba(255,255,255,0.92)',
              fontSize: 10, color: '#94A3B8', display: 'flex', justifyContent: 'space-between',
            }}>
              <span>
                {pickSession
                  ? `Pick tâm bubble ${pickSession.points.length}/3 — click chính xác vào tâm bubble trên ảnh`
                  : 'Kéo=ROI mới · Click area=chọn · Kéo body=move · Kéo handle=resize'}
              </span>
              <span>{pageDims[0]} × {pageDims[1]} · {areas.length} areas</span>
            </div>
          </Card>

          {/* ─── Right panel ── */}
          <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>

            {/* ── Pipeline guide ── */}
            <Card style={{ padding: '10px 14px', background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#065F46', marginBottom: 6 }}>Pipeline Define Areas</div>
              {[
                { step: '1', label: 'Vẽ box ROI', desc: 'Kéo chuột trên canvas bao quanh vùng OMR cần crop' },
                { step: '2', label: 'Chọn Field Type', desc: 'INT = SBD/CCCD/Mã đề · MCQ4 = đáp án A/B/C/D' },
                { step: '3', label: 'Căn bubble grid', desc: 'AutoFit (nhanh) hoặc Pick tâm bubble (chính xác)' },
              ].map(item => (
                <div key={item.step} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'flex-start' }}>
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#059669', color: '#fff', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {item.step}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#065F46' }}>{item.label}</div>
                    <div style={{ fontSize: 10, color: '#6B7280' }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </Card>

            {/* ── Active pick session status ── */}
            {pickSession && (
              <Card style={{ padding: '12px 14px', border: '2px solid #7C3AED', background: '#FAF5FF' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#7C3AED', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Crosshair size={13} /> Pick tâm bubble — {pickSession.points.length}/3
                </div>

                {/* Progress dots */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  {[0,1,2].map(i => (
                    <div key={i} style={{
                      width: 28, height: 28, borderRadius: '50%',
                      background: i < pickSession.points.length ? '#7C3AED' : (i === pickSession.points.length ? '#FAF5FF' : '#F3F4F6'),
                      border: `2px solid ${i <= pickSession.points.length ? '#7C3AED' : '#E5E7EB'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 800,
                      color: i < pickSession.points.length ? '#fff' : (i === pickSession.points.length ? '#7C3AED' : '#9CA3AF'),
                    }}>
                      {i+1}
                    </div>
                  ))}
                </div>

                {currentPickStep && (
                  <div style={{ fontSize: 11, color: '#374151', background: '#EDE9FE', borderRadius: 7, padding: '6px 9px', marginBottom: 10, fontWeight: 600 }}>
                    👉 {currentPickStep}
                  </div>
                )}

                {pickSession.points.length > 0 && (
                  <div style={{ fontSize: 10, color: '#6B7280', marginBottom: 10, fontFamily: 'monospace' }}>
                    {pickSession.points.map((p, i) => (
                      <div key={i}>P{i+1}: ({p.x}, {p.y})</div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={resetPickSession} style={{ flex: 1, padding: '6px 0', borderRadius: 7, fontSize: 11, fontWeight: 700, border: '1.5px solid #E5E7EB', color: '#374151', background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
                    Pick lại
                  </button>
                  <button onClick={cancelPickSession} style={{ flex: 1, padding: '6px 0', borderRadius: 7, fontSize: 11, fontWeight: 700, border: '1.5px solid #DDD6FE', color: '#7C3AED', background: '#F5F3FF', cursor: 'pointer', fontFamily: 'inherit' }}>
                    Hủy
                  </button>
                </div>
              </Card>
            )}

            {/* ── Area count + compact list ── */}
            <Card style={{ padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: areas.length ? 10 : 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{areas.length} vùng đã define</div>
                <button
                  onClick={() => {
                    const box: [number,number,number,number] = [50,50,350,400];
                    const a = defaultArea(box);
                    setAreas(prev => [...prev, a]);
                    setSelectedKey(a.key);
                    setBubblePreviews(prev => ({ ...prev, [a.key]: computePreviewBubbles(a) }));
                  }}
                  style={{ border: '1.5px solid #C8102E', borderRadius: 9999, padding: '3px 10px', fontSize: 11, fontWeight: 700, color: '#C8102E', background: '#FEF2F2', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Plus size={11} /> Thêm area
                </button>
              </div>

              {areas.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {areas.map((a, idx) => {
                    const isSel = a.key === selectedKey;
                    return (
                      <div key={a.key} onClick={() => setSelectedKey(a.key)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 7, cursor: 'pointer', background: isSel ? '#FEF2F2' : 'transparent', border: `1.5px solid ${isSel ? '#C8102E' : '#E5E7EB'}`, transition: 'border-color 100ms' }}
                      >
                        <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: isSel ? '#C8102E' : `hsl(${(idx*67)%360},60%,50%)` }} />
                        <div style={{ flex: 1, fontSize: 12, fontWeight: isSel ? 700 : 400, color: isSel ? '#C8102E' : '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.blockName || `area_${idx+1}`}
                        </div>
                        <span style={{ fontSize: 9, background: isSel?'#C8102E':'#F3F4F6', color: isSel?'#fff':'#6B7280', borderRadius: 4, padding: '1px 5px', flexShrink: 0, fontWeight: 600 }}>
                          {a.fieldType ? a.fieldType.replace('QTYPE_','') : 'custom'}
                        </span>
                        <button onClick={e => { e.stopPropagation(); setAreas(p=>p.filter(x=>x.key!==a.key)); if(selectedKey===a.key) setSelectedKey(null); setBubblePreviews(p=>{const n={...p};delete n[a.key];return n;}); }}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9CA3AF', padding: 2, flexShrink: 0, display: 'flex' }}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Empty state */}
            {areas.length === 0 && (
              <Card style={{ padding: '20px 14px', textAlign: 'center', color: '#9CA3AF' }}>
                <Plus size={28} style={{ opacity: 0.3, margin: '0 auto 8px', display: 'block' }} />
                <div style={{ fontSize: 12 }}>Kéo chuột trên canvas để vẽ<br />vùng ROI đầu tiên</div>
              </Card>
            )}

            {/* Full area config + bubble calibration */}
            {selectedArea && (
              <AreaPanel
                key={selectedArea.key}
                area={selectedArea}
                pickActive={!!pickSession}
                showBubbleDebug={showBubbleDebug}
                onToggleDebug={setShowBubbleDebug}
                onStartPick={startPickSession}
                onCopyJson={() => copyAreaJson(selectedArea)}
                onExportSingle={() => exportSingleArea(selectedArea)}
                onChange={updated => {
                  setAreas(prev => prev.map(p => p.key === updated.key ? updated : p));
                  setBubblePreviews(prev => ({ ...prev, [updated.key]: computePreviewBubbles(updated) }));
                }}
                onDelete={() => {
                  setAreas(prev => prev.filter(p => p.key !== selectedArea.key));
                  setSelectedKey(null);
                  setPickSession(null);
                  setBubblePreviews(prev => { const n={...prev}; delete n[selectedArea.key]; return n; });
                }}
                onRefresh={() => setBubblePreviews(prev => ({ ...prev, [selectedArea.key]: computePreviewBubbles(selectedArea) }))}
              />
            )}

            {!selectedArea && areas.length > 0 && (
              <Card style={{ padding: '14px', textAlign: 'center', color: '#9CA3AF' }}>
                <div style={{ fontSize: 12 }}>Click area trên canvas<br />hoặc danh sách để chỉnh sửa</div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
