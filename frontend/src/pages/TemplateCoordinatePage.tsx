/**
 * TemplateCoordinatePage.tsx — Template Coordinate Picker (Wizard UX)
 *
 * Hai mode:
 *   vju_preset  — 13 field VJU cố định
 *   custom      — người dùng tự thêm/sửa/xóa field
 *
 * INT mapping (swap on export):
 *   JSON bubblesGap = picker vgap   (Y gap giữa các hàng số)
 *   JSON labelsGap  = picker hgap   (X gap giữa các cột số)
 *
 * MCQ4 mapping (no swap):
 *   JSON bubblesGap = picker hgap   (X gap giữa A→D)
 *   JSON labelsGap  = picker vgap   (Y gap giữa các câu)
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Download, Upload, Save, FileImage, ChevronDown, ChevronRight, Plus, Edit2, Trash2 } from 'lucide-react';
import Button from '../components/common/Button';
import Card from '../components/common/Card';
import PageHeader from '../components/layout/PageHeader';
import { requestRaw, customFormsApi, type CustomFormMeta, type CustomFormDetail } from '../services/apiClient';

// ── Types ─────────────────────────────────────────────────────────────────────

type PickStep     = 'roi' | 'box' | 'hgap' | 'vgap' | 'done';
type SubMode      = 'firstlast' | 'multi';
type TemplateMode = 'vju_preset' | 'custom';

interface FieldDef {
  key:                string;
  label:              string;
  shortLabel:         string;
  group:              'info' | 'mcq';
  fieldType:          'QTYPE_INT' | 'QTYPE_MCQ4';
  rows:               number;
  cols:               number;
  color:              string;
  labelPrefix:        string;
  labelStart:         number;
  includeInAnswerKey: boolean;
  isPreset?:          boolean;
}

interface FieldMeasurement {
  box:              [number, number, number, number] | null;
  origin:           [number, number] | null;
  bubbleDimensions: [number, number] | null;
  hgap:             number | null;
  vgap:             number | null;
  rows:             number;
  cols:             number;
}

interface ClickPt { x: number; y: number; }

interface StepGuide {
  title:        string;
  instructions: string[];
  clickGoal?:   string;
}

// ── VJU preset fields ─────────────────────────────────────────────────────────

const VJU_FIELDS: FieldDef[] = [
  { key: 'CCCD',                label: 'CCCD (12 cột)',       shortLabel: 'CCCD',           group: 'info', fieldType: 'QTYPE_INT',  rows: 10, cols: 12, color: '#4488ff', labelPrefix: 'cccd',   labelStart: 1, includeInAnswerKey: false, isPreset: true },
  { key: 'SoBaoDanh',           label: 'SBD (8 cột)',         shortLabel: 'Số báo danh',    group: 'info', fieldType: 'QTYPE_INT',  rows: 10, cols: 8,  color: '#ff8844', labelPrefix: 'sbd',    labelStart: 1, includeInAnswerKey: false, isPreset: true },
  { key: 'MaDe',                label: 'Mã đề (3 cột)',       shortLabel: 'Mã đề',          group: 'info', fieldType: 'QTYPE_INT',  rows: 10, cols: 3,  color: '#44cc66', labelPrefix: 'made',   labelStart: 1, includeInAnswerKey: false, isPreset: true },
  { key: 'CaThi',               label: 'Ca thi (2 cột)',      shortLabel: 'Ca thi',         group: 'info', fieldType: 'QTYPE_INT',  rows: 10, cols: 2,  color: '#44cccc', labelPrefix: 'cathi',  labelStart: 1, includeInAnswerKey: false, isPreset: true },
  { key: 'MaCTDT',              label: 'Mã CTĐT (2 cột)',    shortLabel: 'Mã CTĐT',        group: 'info', fieldType: 'QTYPE_INT',  rows: 10, cols: 2,  color: '#cc44cc', labelPrefix: 'mactdt', labelStart: 1, includeInAnswerKey: false, isPreset: true },
  { key: 'TuChon',              label: 'Tự chọn (2 cột)',    shortLabel: 'Tự chọn',        group: 'info', fieldType: 'QTYPE_INT',  rows: 10, cols: 2,  color: '#ffcc44', labelPrefix: 'tc',     labelStart: 1, includeInAnswerKey: false, isPreset: true },
  { key: 'BatBuoc_Toan',        label: 'Toán bắt buộc (15)', shortLabel: 'Toán bắt buộc',  group: 'mcq',  fieldType: 'QTYPE_MCQ4', rows: 15, cols: 4,  color: '#e94560', labelPrefix: 'toan',   labelStart: 1, includeInAnswerKey: true,  isPreset: true },
  { key: 'BatBuoc_PTBV',        label: 'PTBV bắt buộc (5)', shortLabel: 'PTBV bắt buộc',  group: 'mcq',  fieldType: 'QTYPE_MCQ4', rows: 5,  cols: 4,  color: '#e07040', labelPrefix: 'ptbv',   labelStart: 1, includeInAnswerKey: true,  isPreset: true },
  { key: 'TuChon_VatLy',        label: 'Vật lý (10)',         shortLabel: 'Vật lý',         group: 'mcq',  fieldType: 'QTYPE_MCQ4', rows: 10, cols: 4,  color: '#d060c0', labelPrefix: 'vl',     labelStart: 1, includeInAnswerKey: true,  isPreset: true },
  { key: 'TuChon_HoaHoc',       label: 'Hóa học (10)',        shortLabel: 'Hóa học',        group: 'mcq',  fieldType: 'QTYPE_MCQ4', rows: 10, cols: 4,  color: '#60a0e0', labelPrefix: 'hh',     labelStart: 1, includeInAnswerKey: true,  isPreset: true },
  { key: 'TuChon_SinhHoc_1_5',  label: 'Sinh học 1–5',        shortLabel: 'Sinh học 1–5',   group: 'mcq',  fieldType: 'QTYPE_MCQ4', rows: 5,  cols: 4,  color: '#40c080', labelPrefix: 'sh',     labelStart: 1, includeInAnswerKey: true,  isPreset: true },
  { key: 'TuChon_SinhHoc_6_10', label: 'Sinh học 6–10',       shortLabel: 'Sinh học 6–10',  group: 'mcq',  fieldType: 'QTYPE_MCQ4', rows: 5,  cols: 4,  color: '#40e0c0', labelPrefix: 'sh',     labelStart: 6, includeInAnswerKey: true,  isPreset: true },
  { key: 'TuChon_CNNN',         label: 'CNNN (10)',            shortLabel: 'CNNN',           group: 'mcq',  fieldType: 'QTYPE_MCQ4', rows: 10, cols: 4,  color: '#a0c040', labelPrefix: 'cnnn',   labelStart: 1, includeInAnswerKey: true,  isPreset: true },
];

// ── Custom field color palette ─────────────────────────────────────────────────

const CUSTOM_COLORS = [
  '#6366f1','#f43f5e','#10b981','#f59e0b','#3b82f6',
  '#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4',
];

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_PAGE: [number, number] = [1000, 1414];
const DRAFT_KEY    = 'vju_coord_picker_v3';   // bumped from v2 (format changed)
const STEP_NUM: Record<PickStep, number> = { roi: 1, box: 2, hgap: 3, vgap: 4, done: 4 };
const TOTAL_STEPS  = 4;

// ── Step guide ────────────────────────────────────────────────────────────────

function getStepGuide(def: FieldDef, step: PickStep, clickCount: number, subMode: SubMode): StepGuide {
  const isInt    = def.fieldType === 'QTYPE_INT';
  const typeStr  = isInt ? 'Dạng số' : 'Dạng A/B/C/D';

  switch (step) {
    case 'roi':
      return {
        title: 'Bước 1 — Khoanh vùng field',
        instructions: [
          `Kéo chuột bao quanh toàn bộ vùng ${def.shortLabel} trên phiếu.`,
          'Box này giúp hệ thống cắt ảnh đúng vùng khi chấm bài.',
          'Không cần chính xác tuyệt đối — chỉ cần bao trọn vùng đó.',
        ],
        clickGoal: clickCount === 0 ? 'Click góc trên-trái' : 'Click góc dưới-phải',
      };
    case 'box':
      return {
        title: 'Bước 2 — Đo bubble đầu tiên',
        instructions: isInt ? [
          'Click vào 2 góc của ô tô số đầu tiên (hàng 0, cột 1):',
          '① Góc trên-trái của ô',
          '② Góc dưới-phải của ô',
          'Hệ thống tính kích thước bubble từ 2 điểm này.',
        ] : [
          'Click vào 2 góc của ô A, câu 1:',
          '① Góc trên-trái của ô A',
          '② Góc dưới-phải của ô A',
          'Hệ thống tính kích thước bubble từ 2 điểm này.',
        ],
        clickGoal: clickCount === 0 ? 'Click ① Góc trên-trái' : 'Click ② Góc dưới-phải',
      };
    case 'hgap':
      return {
        title: 'Bước 3 — Đo khoảng cách ngang',
        instructions: isInt ? [
          `Click tâm bubble (giữa ô) ở hàng số 0:`,
          `① Tâm cột 1 (cột đầu tiên)`,
          `② Tâm cột ${def.cols} (cột cuối cùng)`,
          subMode === 'multi'
            ? 'Hoặc click nhiều cột → hệ thống tự tính khoảng cách trung bình.'
            : 'Hệ thống tính khoảng cách = (cột cuối - cột đầu) ÷ (số cột - 1).',
        ] : [
          'Click tâm bubble (giữa ô) ở câu 1:',
          '① Tâm ô A (đầu tiên)',
          '② Tâm ô D (cuối cùng)',
          subMode === 'multi'
            ? 'Hoặc click nhiều ô → hệ thống tự tính khoảng cách trung bình.'
            : 'Hệ thống tính khoảng cách = (ô D - ô A) ÷ 3.',
        ],
        clickGoal: clickCount === 0 ? 'Click ① tâm bubble đầu' : clickCount === 1 ? 'Click ② tâm bubble cuối' : `Đã click ${clickCount} điểm`,
      };
    case 'vgap':
      return {
        title: 'Bước 4 — Đo khoảng cách dọc',
        instructions: isInt ? [
          'Click tâm bubble ở cột 1:',
          '① Tâm hàng số 0 (trên cùng)',
          '② Tâm hàng số 9 (dưới cùng)',
          subMode === 'multi'
            ? 'Hoặc click nhiều hàng → hệ thống tự tính trung bình.'
            : 'Hệ thống tính khoảng cách = (hàng 9 - hàng 0) ÷ 9.',
        ] : [
          `Click tâm ô A:`,
          '① Tâm câu 1 (trên cùng)',
          `② Tâm câu ${def.rows} (dưới cùng)`,
          subMode === 'multi'
            ? 'Hoặc click nhiều câu → hệ thống tự tính trung bình.'
            : `Hệ thống tính khoảng cách = (câu ${def.rows} - câu 1) ÷ ${def.rows - 1}.`,
        ],
        clickGoal: clickCount === 0 ? 'Click ① tâm bubble đầu' : clickCount === 1 ? 'Click ② tâm bubble cuối' : `Đã click ${clickCount} điểm`,
      };
    case 'done':
      return {
        title: `${typeStr} · ${isInt ? `${def.cols} cột × ${def.rows} hàng` : `${def.rows} câu × ${def.cols} lựa chọn`}`,
        instructions: [
          '✅ Grid đã được tạo! Kiểm tra các ô có khớp với bubble trên phiếu không.',
          'Dùng phím ← → ↑ ↓ để dịch nhẹ vị trí bubble nếu bị lệch.',
          'Giữ Shift + phím mũi tên để dịch nhanh hơn (×5).',
        ],
      };
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function fmt2(v: number | null | undefined): string {
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function r2(v: number): number { return Math.round(v * 100) / 100; }

function linReg(xs: number[], ys: number[]): { a: number; b: number; maxErr: number } {
  const n = xs.length;
  if (n < 2) return { a: ys[0] ?? 0, b: 0, maxErr: 0 };
  const sx = xs.reduce((s, x) => s + x, 0), sy = ys.reduce((s, y) => s + y, 0);
  const sxy = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const sx2 = xs.reduce((s, x) => s + x * x, 0);
  const b = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
  const a = (sy - b * sx) / n;
  const maxErr = Math.max(...ys.map((y, i) => Math.abs(y - (a + b * xs[i]))));
  return { a, b, maxErr };
}

function initFm(def: FieldDef): FieldMeasurement {
  return { box: null, origin: null, bubbleDimensions: null, hgap: null, vgap: null, rows: def.rows, cols: def.cols };
}

function isComplete(fm: FieldMeasurement): boolean {
  return !!(fm.origin && fm.bubbleDimensions && fm.hgap != null && fm.vgap != null);
}

function makeLabels(prefix: string, start: number, count: number): string {
  // Format: "cccd1..12" — prefix only on the left, end index only on right.
  // template_loader.py's _RANGE_REGEX expects ([^\d.]+)(\d+)\.{2,3}(\d+),
  // so the prefix must NOT be repeated after the dots.
  return `${prefix}${start}..${start + count - 1}`;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'field';
}

// ── JSON payload builder ──────────────────────────────────────────────────────
// INT:  JSON bubblesGap = vgap, labelsGap = hgap  [SWAP]
// MCQ4: JSON bubblesGap = hgap, labelsGap = vgap  [no swap]

function fieldToPayload(def: FieldDef, fm: FieldMeasurement, pageDims: [number, number]) {
  const isInt          = def.fieldType === 'QTYPE_INT';
  const box            = fm.box ?? ([0, 0, pageDims[0], pageDims[1]] as [number, number, number, number]);
  const labelCount     = isInt ? fm.cols : fm.rows;
  const fieldLabels    = makeLabels(def.labelPrefix, def.labelStart, labelCount);
  const jsonBubblesGap = isInt ? (fm.vgap ?? 0) : (fm.hgap ?? 0);
  const jsonLabelsGap  = isInt ? (fm.hgap ?? 0) : (fm.vgap ?? 0);
  return {
    type:               'omr' as const,
    key:                def.key,
    blockName:          def.key,
    semanticType:       undefined as string | undefined,
    fieldType:          def.fieldType,
    box,
    origin:             fm.origin ?? ([box[0], box[1]] as [number, number]),
    physicalRows:       fm.rows,
    physicalCols:       fm.cols,
    labelPrefix:        def.labelPrefix,
    labelStart:         def.labelStart,
    fieldLabels,
    bubblesGap:         Math.round(jsonBubblesGap),
    labelsGap:          Math.round(jsonLabelsGap),
    bubbleDimensions:   fm.bubbleDimensions ?? [19, 19],
    autoFit:            false,
    includeInAnswerKey: def.includeInAnswerKey,
    excludeFromAnswerKey: false,
  };
}

// ── Canvas draw helpers ───────────────────────────────────────────────────────

function drawCross(ctx: CanvasRenderingContext2D, px: number, py: number, color: string, r = 8) {
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(px - r, py); ctx.lineTo(px + r, py); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(px, py - r); ctx.lineTo(px, py + r); ctx.stroke();
  ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
}

function drawGrid(
  ctx:       CanvasRenderingContext2D,
  fm:        FieldMeasurement,
  zoom:      number,
  color:     string,
  isCurrent: boolean,
) {
  if (!fm.origin || !fm.bubbleDimensions) return;
  const [ox, oy] = fm.origin;
  const [bw, bh] = fm.bubbleDimensions;
  const gx = fm.hgap ?? (bw + 4);
  const gy = fm.vgap ?? (bh + 4);
  const { rows, cols } = fm;

  ctx.strokeStyle = isCurrent ? color : color + '55';
  ctx.lineWidth   = isCurrent ? 1.5 : 0.8;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = (ox + col * gx) * zoom;
      const cy = (oy + row * gy) * zoom;
      const cw = bw * zoom, ch = bh * zoom;
      if (isCurrent) {
        ctx.fillStyle = color + '18'; ctx.fillRect(cx, cy, cw, ch);
      }
      ctx.strokeRect(cx, cy, cw, ch);
      if (isCurrent) {
        ctx.beginPath(); ctx.arc(cx + cw / 2, cy + ch / 2, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = color + '80'; ctx.fill();
      }
    }
  }

  if (isCurrent) {
    const px = ox * zoom, py = oy * zoom;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px - 9, py); ctx.lineTo(px + 9, py); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px, py - 9); ctx.lineTo(px, py + 9); ctx.stroke();
    ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.font = `bold ${Math.max(8, 9 * zoom)}px monospace`;
    ctx.fillStyle = '#fff'; ctx.fillText('TL', px + 5, py - 5);
    const lx = (ox + (cols - 1) * gx) * zoom;
    const ly = (oy + (rows - 1) * gy) * zoom;
    ctx.strokeStyle = '#ff4'; ctx.lineWidth = 2;
    ctx.strokeRect(lx, ly, bw * zoom, bh * zoom);
  }
}

// ── AddField form type ────────────────────────────────────────────────────────

interface AddFieldForm {
  name:               string;
  fieldType:          'QTYPE_INT' | 'QTYPE_MCQ4';
  rows:               number;
  cols:               number;
  labelPrefix:        string;
  labelStart:         number;
  includeInAnswerKey: boolean;
}

const EMPTY_FORM: AddFieldForm = {
  name: '', fieldType: 'QTYPE_INT', rows: 10, cols: 8,
  labelPrefix: '', labelStart: 1, includeInAnswerKey: false,
};

// ── Main component ────────────────────────────────────────────────────────────

export default function TemplateCoordinatePage() {
  // ── URL params ────────────────────────────────────────────────────────────
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const editTemplateIdParam = searchParams.get('templateId');

  // ── Edit mode state ──────────────────────────────────────────────────────
  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [isEditMode,        setIsEditMode]        = useState(false);

  // ── Template list (for selector dropdown) ───────────────────────────────
  const [templates,        setTemplates]        = useState<CustomFormMeta[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  // ── Core state ───────────────────────────────────────────────────────────
  const [imgSrc,        setImgSrc]        = useState<string | null>(null);
  const [pageDims,      setPageDims]      = useState<[number, number]>(DEFAULT_PAGE);
  const [templateName,  setTemplateName]  = useState('VJU SBD8 Template');
  const [zoom,          setZoom]          = useState(0.7);
  const [showAdvanced,  setShowAdvanced]  = useState(false);
  const [alignMethod,   setAlignMethod]   = useState<'markers' | 'croppage' | 'none' | null>(null);

  // ── Template mode ────────────────────────────────────────────────────────
  const [templateMode,  setTemplateMode]  = useState<TemplateMode>('vju_preset');
  const [customFields,  setCustomFields]  = useState<FieldDef[]>([]);

  // ── Add/Edit field modal ─────────────────────────────────────────────────
  const [showAddModal,  setShowAddModal]  = useState(false);
  const [editingKey,    setEditingKey]    = useState<string | null>(null);
  const [addForm,       setAddForm]       = useState<AddFieldForm>(EMPTY_FORM);

  // ── Field measurement state ──────────────────────────────────────────────
  const [fieldStates,   setFieldStates]   = useState<Record<string, FieldMeasurement>>(() => {
    const init: Record<string, FieldMeasurement> = {};
    VJU_FIELDS.forEach(f => { init[f.key] = initFm(f); });
    return init;
  });

  // ── Wizard state ─────────────────────────────────────────────────────────
  const [curFieldKey,   setCurFieldKey]   = useState<string>(VJU_FIELDS[0].key);
  const [curStep,       setCurStep]       = useState<PickStep>('roi');
  const [subMode,       setSubModeState]  = useState<SubMode>('firstlast');
  const [clicks,        setClicks]        = useState<ClickPt[]>([]);
  const [stepDetails,   setStepDetails]   = useState<Record<string, string>>({});
  const [stepWarns,     setStepWarns]     = useState<Record<string, string>>({});
  const [saving,        setSaving]        = useState(false);
  const [saveMsg,       setSaveMsg]       = useState('');

  // ── Refs ─────────────────────────────────────────────────────────────────
  const canvasRef          = useRef<HTMLCanvasElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const imgRef             = useRef<HTMLImageElement | null>(null);
  const hoverPosRef        = useRef<[number, number] | null>(null);
  const clicksRef          = useRef(clicks);    clicksRef.current = clicks;
  const stepRef            = useRef(curStep);   stepRef.current   = curStep;
  const cursorRef          = useRef<HTMLSpanElement>(null);
  const fileInputRef       = useRef<HTMLInputElement>(null);
  const importRef          = useRef<HTMLInputElement>(null);

  // ── Derived ──────────────────────────────────────────────────────────────
  const activeFields = useMemo(
    () => templateMode === 'vju_preset' ? VJU_FIELDS : customFields,
    [templateMode, customFields],
  );
  const hasActiveFields = activeFields.length > 0;
  const curDef: FieldDef = (activeFields.find(f => f.key === curFieldKey) ?? activeFields[0]) ?? VJU_FIELDS[0];
  const curFm:  FieldMeasurement = fieldStates[curDef?.key] ?? initFm(curDef);
  const completedCount = activeFields.filter(d => isComplete(fieldStates[d.key] ?? initFm(d))).length;

  // ── Fit page ──────────────────────────────────────────────────────────────
  function computeFitZoom(w: number, h: number): number {
    const container = canvasContainerRef.current;
    const cw = container ? Math.max(300, container.clientWidth  - 20) : 700;
    const ch = container ? Math.max(300, container.clientHeight - 50) : 900;
    return Math.round(Math.min(cw / w, ch / h, 1.0) * 20) / 20;
  }
  function fitPage() {
    if (!imgRef.current) return;
    setZoom(computeFitZoom(pageDims[0], pageDims[1]));
  }

  // ── Canvas resize ─────────────────────────────────────────────────────────
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    c.width  = Math.round(pageDims[0] * zoom);
    c.height = Math.round(pageDims[1] * zoom);
  }, [pageDims, zoom]);

  // ── Redraw ────────────────────────────────────────────────────────────────
  const doRedraw = useCallback(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;

    ctx.clearRect(0, 0, c.width, c.height);

    if (imgRef.current) {
      ctx.drawImage(imgRef.current, 0, 0, c.width, c.height);
    } else {
      ctx.fillStyle = '#f4f5f7'; ctx.fillRect(0, 0, c.width, c.height);
      // Empty state placeholder text (HTML overlay handles the card UI)
      ctx.textAlign = 'left';
    }

    // Other completed fields (dimmed)
    activeFields.forEach(def => {
      if (def.key === curDef?.key) return;
      const fm = fieldStates[def.key];
      if (!fm?.origin || !fm.bubbleDimensions) return;
      drawGrid(ctx, fm, zoom, def.color, false);
      if (fm.box) {
        const [bx1, by1, bx2, by2] = fm.box;
        ctx.strokeStyle = def.color + '44'; ctx.lineWidth = 0.8;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(bx1 * zoom, by1 * zoom, (bx2 - bx1) * zoom, (by2 - by1) * zoom);
        ctx.setLineDash([]);
      }
    });

    if (!curDef) return;
    const fm  = curFm;
    const clr = curDef.color;

    // Current field ROI box
    if (fm.box) {
      const [bx1, by1, bx2, by2] = fm.box;
      ctx.fillStyle = clr + '0A'; ctx.strokeStyle = clr + 'cc'; ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.fillRect  (bx1 * zoom, by1 * zoom, (bx2 - bx1) * zoom, (by2 - by1) * zoom);
      ctx.strokeRect(bx1 * zoom, by1 * zoom, (bx2 - bx1) * zoom, (by2 - by1) * zoom);
      ctx.setLineDash([]);
      ctx.font = `bold ${Math.max(9, 10 * zoom)}px sans-serif`;
      ctx.fillStyle = clr;
      ctx.fillText(curDef.shortLabel, bx1 * zoom + 4 * zoom, by1 * zoom + 14 * zoom);
    }

    if (fm.origin && fm.bubbleDimensions) drawGrid(ctx, fm, zoom, clr, true);

    // Hover preview rect
    const hover = hoverPosRef.current;
    const cl    = clicksRef.current;
    if (hover && (curStep === 'roi' || curStep === 'box') && cl.length === 1) {
      const x1 = cl[0].x * zoom, y1 = cl[0].y * zoom;
      const x2 = hover[0] * zoom, y2 = hover[1] * zoom;
      ctx.strokeStyle = clr; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.fillStyle = clr + '0A';
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.setLineDash([]);
    }

    // Regression line
    if (subMode === 'multi' && cl.length >= 2 && (curStep === 'hgap' || curStep === 'vgap')) {
      const xs = cl.map((_, i) => i);
      const ys = cl.map(pt => curStep === 'hgap' ? pt.x : pt.y);
      const { a, b } = linReg(xs, ys);
      ctx.strokeStyle = clr + '88'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.beginPath();
      const li = cl.length - 1;
      const fx = curStep === 'hgap' ? a : cl[0].x, fy = curStep === 'vgap' ? a : cl[0].y;
      const lx = curStep === 'hgap' ? a + b * li : cl[li].x, ly = curStep === 'vgap' ? a + b * li : cl[li].y;
      ctx.moveTo(fx * zoom, fy * zoom); ctx.lineTo(lx * zoom, ly * zoom);
      ctx.stroke(); ctx.setLineDash([]);
    }

    // Click points
    cl.forEach((pt, i) => {
      const label = (curStep === 'roi' || curStep === 'box')
        ? (i === 0 ? '①' : '②')
        : (i === 0 ? 'P1' : i === 1 ? 'P2' : `P${i + 1}`);
      drawCross(ctx, pt.x * zoom, pt.y * zoom, clr);
      ctx.font = `bold ${Math.max(10, 11 * zoom)}px sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.fillText(label, pt.x * zoom + 6, pt.y * zoom - 5);
    });

    // Gap delta line + label
    if ((curStep === 'hgap' || curStep === 'vgap') && cl.length >= 2) {
      ctx.strokeStyle = clr + '66'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath();
      cl.forEach((pt, i) => { i === 0 ? ctx.moveTo(pt.x * zoom, pt.y * zoom) : ctx.lineTo(pt.x * zoom, pt.y * zoom); });
      ctx.stroke(); ctx.setLineDash([]);
      if (subMode === 'firstlast' && cl.length === 2) {
        const total = curStep === 'hgap' ? Math.abs(cl[1].x - cl[0].x) : Math.abs(cl[1].y - cl[0].y);
        const N     = curStep === 'hgap' ? Math.max(1, fm.cols - 1) : Math.max(1, fm.rows - 1);
        const mx    = (cl[0].x + cl[1].x) / 2 * zoom, my = (cl[0].y + cl[1].y) / 2 * zoom;
        ctx.fillStyle = '#80ffb0';
        ctx.font = `bold ${Math.max(9, 11 * zoom)}px monospace`;
        ctx.fillText(`${total} ÷ ${N} = ${(total / N).toFixed(2)}px`, mx + 4, my - 14);
      }
    }

    // Canvas overlay hint
    if (curStep !== 'done' || !fm.origin) {
      const stepNum  = STEP_NUM[curStep];
      const stepName = curStep === 'roi' ? 'Khoanh vùng' : curStep === 'box' ? 'Đo bubble đầu' : curStep === 'hgap' ? 'Đo ngang' : curStep === 'vgap' ? 'Đo dọc' : 'Hoàn tất';
      const hint     = cl.length === 0 ? 'Click điểm đầu tiên' : cl.length === 1 && (curStep === 'roi' || curStep === 'box') ? 'Click điểm thứ hai' : cl.length >= 2 ? 'Nhấn ✓ Xác nhận hoặc tiếp tục click' : '';
      const line1    = `Bước ${stepNum}/${TOTAL_STEPS} — ${stepName}: ${curDef.shortLabel}`;
      const fsz      = Math.max(11, 12 * zoom);
      ctx.font       = `bold ${fsz}px sans-serif`;
      const tw1 = ctx.measureText(line1).width, tw2 = ctx.measureText(hint).width;
      const w = Math.max(tw1, tw2) + 16, h = hint ? 40 : 22;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      const rx = 8, ry = 8;
      ctx.beginPath();
      ctx.moveTo(rx + 8, ry); ctx.lineTo(rx + w - 8, ry);
      ctx.quadraticCurveTo(rx + w, ry, rx + w, ry + 8);
      ctx.lineTo(rx + w, ry + h - 8);
      ctx.quadraticCurveTo(rx + w, ry + h, rx + w - 8, ry + h);
      ctx.lineTo(rx + 8, ry + h);
      ctx.quadraticCurveTo(rx, ry + h, rx, ry + h - 8);
      ctx.lineTo(rx, ry + 8);
      ctx.quadraticCurveTo(rx, ry, rx + 8, ry);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = clr; ctx.font = `bold ${fsz}px sans-serif`;
      ctx.fillText(line1, rx + 8, ry + 14);
      if (hint) {
        ctx.font = `${Math.max(9, 10 * zoom)}px sans-serif`;
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(hint, rx + 8, ry + 30);
      }
    }
  }, [activeFields, fieldStates, curDef, curFm, curStep, clicks, zoom, subMode, pageDims, imgSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { doRedraw(); }, [doRedraw]);

  // ── Image loading ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!imgSrc) { imgRef.current = null; return; }
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const w = img.naturalWidth, h = img.naturalHeight;
      setPageDims([w, h]);
      const container = canvasContainerRef.current;
      if (container) {
        const cw = Math.max(300, container.clientWidth  - 20);
        const ch = Math.max(300, container.clientHeight - 50);
        setZoom(Math.round(Math.min(cw / w, ch / h, 1.0) * 20) / 20);
      } else { setZoom(0.7); }
    };
    img.src = imgSrc;
  }, [imgSrc]);

  // ── Draft persistence (skip in edit mode to avoid polluting create-mode draft) ─
  useEffect(() => {
    if (editingTemplateId) return; // Don't overwrite draft when editing existing template
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        fieldStates, templateName, pageDims, templateMode, customFields,
      }));
    } catch { /* ignore */ }
  }, [fieldStates, templateName, pageDims, templateMode, customFields, editingTemplateId]);

  useEffect(() => {
    // Skip draft restore when editing an existing template — API data takes precedence
    if (editTemplateIdParam) return;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY); if (!raw) return;
      const d = JSON.parse(raw) as {
        fieldStates?:  Record<string, FieldMeasurement>;
        templateName?: string;
        pageDims?:     [number, number];
        templateMode?: TemplateMode;
        customFields?: FieldDef[];
      };
      if (d.templateMode) setTemplateMode(d.templateMode);
      if (d.customFields) setCustomFields(d.customFields);
      if (d.fieldStates) {
        setFieldStates(prev => {
          const next = { ...prev };
          // restore VJU fields
          VJU_FIELDS.forEach(f => { if (d.fieldStates![f.key]) next[f.key] = { ...initFm(f), ...d.fieldStates![f.key] }; });
          // restore custom fields
          (d.customFields ?? []).forEach(f => { if (d.fieldStates![f.key]) next[f.key] = { ...initFm(f), ...d.fieldStates![f.key] }; });
          return next;
        });
      }
      if (d.templateName) setTemplateName(d.templateName);
      if (d.pageDims)     setPageDims(d.pageDims);
      if (d.templateMode === 'custom' && d.customFields?.length) {
        setCurFieldKey(d.customFields[0].key);
      }
    } catch { /* ignore */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load templates list on mount ─────────────────────────────────────────
  useEffect(() => {
    setTemplatesLoading(true);
    customFormsApi.list()
      .then(r => setTemplates(r.forms ?? []))
      .catch(() => { /* silently ignore — dropdown just shows empty */ })
      .finally(() => setTemplatesLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── loadTemplateDetailIntoEditor — shared helper ─────────────────────────
  function loadTemplateDetailIntoEditor(detail: CustomFormDetail) {
    const areas    = (detail.areas ?? []) as Record<string, unknown>[];
    const omrAreas = areas.filter(a => a['type'] === 'omr');

    const vjuKeys     = new Set(VJU_FIELDS.map(f => f.key));
    const allMatchVju = omrAreas.length > 0 && omrAreas.every(a => vjuKeys.has(String(a['blockName'] ?? '')));

    setTemplateName(detail.name);
    if (detail.page_width && detail.page_height) {
      setPageDims([detail.page_width, detail.page_height]);
    }

    if (allMatchVju) {
      // ── VJU preset mode ──
      setTemplateMode('vju_preset');
      const next: Record<string, FieldMeasurement> = {};
      VJU_FIELDS.forEach(f => { next[f.key] = initFm(f); });
      omrAreas.forEach(a => {
        const key = String(a['blockName'] ?? '');
        const def = VJU_FIELDS.find(f => f.key === key);
        if (!def) return;
        const isInt = def.fieldType === 'QTYPE_INT';
        const bg = Number(a['bubblesGap']) || 0;
        const lg = Number(a['labelsGap'])  || 0;
        next[key] = {
          box:              Array.isArray(a['box'])              ? (a['box'] as [number,number,number,number]) : null,
          origin:           Array.isArray(a['origin'])           ? (a['origin'] as [number,number]) : null,
          bubbleDimensions: Array.isArray(a['bubbleDimensions']) ? (a['bubbleDimensions'] as [number,number]) : null,
          hgap: isInt ? lg : bg,
          vgap: isInt ? bg : lg,
          rows: Number(a['physicalRows']) || def.rows,
          cols: Number(a['physicalCols']) || def.cols,
        };
      });
      setFieldStates(next);
      setCurFieldKey(VJU_FIELDS[0].key);
    } else {
      // ── Custom mode ──
      setTemplateMode('custom');
      const newFields: FieldDef[] = omrAreas.map((a, idx) => {
        const key = String(a['blockName'] ?? `custom_${idx}`);
        const ft  = String(a['fieldType'] ?? 'QTYPE_INT') as 'QTYPE_INT' | 'QTYPE_MCQ4';
        const rows = Number(a['physicalRows']) || 10;
        const cols = Number(a['physicalCols']) || 8;
        const labelPrefix = String(a['labelPrefix'] ?? slugify(key));
        const labelStart  = Number(a['labelStart'])  || 1;
        const includeInAnswerKey = Boolean(a['includeInAnswerKey']);
        const color = CUSTOM_COLORS[idx % CUSTOM_COLORS.length];
        return {
          key,
          label:              ft === 'QTYPE_INT' ? `${key} (${cols} cột)` : `${key} (${rows} câu)`,
          shortLabel:         key,
          group:              (ft === 'QTYPE_INT' ? 'info' : 'mcq') as 'info' | 'mcq',
          fieldType:          ft,
          rows, cols, color, labelPrefix, labelStart, includeInAnswerKey,
          isPreset:           false,
        };
      });
      setCustomFields(newFields);
      const next: Record<string, FieldMeasurement> = {};
      omrAreas.forEach((a, idx) => {
        const key   = String(a['blockName'] ?? `custom_${idx}`);
        const ft    = String(a['fieldType'] ?? 'QTYPE_INT') as 'QTYPE_INT' | 'QTYPE_MCQ4';
        const isInt = ft === 'QTYPE_INT';
        const bg    = Number(a['bubblesGap']) || 0;
        const lg    = Number(a['labelsGap'])  || 0;
        next[key] = {
          box:              Array.isArray(a['box'])              ? (a['box'] as [number,number,number,number]) : null,
          origin:           Array.isArray(a['origin'])           ? (a['origin'] as [number,number]) : null,
          bubbleDimensions: Array.isArray(a['bubbleDimensions']) ? (a['bubbleDimensions'] as [number,number]) : null,
          hgap: isInt ? lg : bg,
          vgap: isInt ? bg : lg,
          rows: Number(a['physicalRows']) || 10,
          cols: Number(a['physicalCols']) || 8,
        };
      });
      setFieldStates(next);
      setCurFieldKey(newFields[0]?.key ?? '');
    }

    setCurStep('roi');
    setClicks([]);
    setSaveMsg(`✓ Đã tải template "${detail.name}" — upload ảnh để overlay và chỉnh sửa tọa độ`);
  }

  // ── Load existing template when editing (templateId param) ────────────────
  useEffect(() => {
    if (!editTemplateIdParam) return;
    const tid = Number(editTemplateIdParam);
    if (isNaN(tid)) return;
    setIsEditMode(true);
    setEditingTemplateId(tid);
    customFormsApi.get(tid)
      .then(detail => { loadTemplateDetailIntoEditor(detail); })
      .catch(err => { alert(`Không thể tải template: ${String(err)}`); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Template selector helpers ─────────────────────────────────────────────
  function resetToNewTemplate() {
    setIsEditMode(false);
    setEditingTemplateId(null);
    setTemplateName('VJU SBD8 Template');
    setTemplateMode('vju_preset');
    const fresh: Record<string, FieldMeasurement> = {};
    VJU_FIELDS.forEach(f => { fresh[f.key] = initFm(f); });
    setFieldStates(fresh);
    setCustomFields([]);
    setCurFieldKey(VJU_FIELDS[0].key);
    setCurStep('roi');
    setClicks([]);
    setImgSrc(null);
    setSaveMsg('');
    navigate('/app/template-coordinate', { replace: true });
  }

  async function handleSelectTemplate(idStr: string) {
    if (idStr === '') return; // placeholder
    if (idStr === '__new__') {
      const hasChanges = completedCount > 0 || templateName !== 'VJU SBD8 Template';
      if (hasChanges && !window.confirm('Bạn có thay đổi chưa lưu. Tạo template mới sẽ xóa dữ liệu hiện tại. Tiếp tục?')) return;
      resetToNewTemplate();
      return;
    }
    const tid = Number(idStr);
    if (isNaN(tid)) return;
    const hasChanges = completedCount > 0 || isEditMode;
    if (hasChanges && !window.confirm('Bạn có thay đổi chưa lưu. Tải template khác sẽ mất dữ liệu hiện tại. Tiếp tục?')) return;
    try {
      const detail = await customFormsApi.get(tid);
      setIsEditMode(true);
      setEditingTemplateId(tid);
      setImgSrc(null);
      loadTemplateDetailIntoEditor(detail);
      navigate(`/app/template-coordinate?templateId=${tid}`, { replace: true });
    } catch (err) {
      alert(`Không thể tải template: ${String(err)}`);
    }
  }

  // ── Template mode switch ──────────────────────────────────────────────────
  function switchTemplateMode(mode: TemplateMode) {
    if (mode === templateMode) return;
    setTemplateMode(mode);
    setClicks([]); setStepDetails({}); setStepWarns({}); setCurStep('roi');
    if (mode === 'vju_preset') {
      setTemplateName('VJU SBD8 Template');
      setCurFieldKey(VJU_FIELDS[0].key);
    } else {
      setTemplateName('Custom Template');
      setCurFieldKey(customFields[0]?.key ?? '');
    }
  }

  // ── Add / Edit / Delete field (custom mode) ───────────────────────────────
  function openAddModal() {
    setEditingKey(null);
    setAddForm({ ...EMPTY_FORM });
    setShowAddModal(true);
  }

  function openEditModal(def: FieldDef) {
    setEditingKey(def.key);
    setAddForm({
      name:               def.shortLabel,
      fieldType:          def.fieldType,
      rows:               def.rows,
      cols:               def.cols,
      labelPrefix:        def.labelPrefix,
      labelStart:         def.labelStart,
      includeInAnswerKey: def.includeInAnswerKey,
    });
    setShowAddModal(true);
  }

  function saveField() {
    const { name, fieldType, rows, cols, includeInAnswerKey } = addForm;
    if (!name.trim()) { alert('Vui lòng nhập tên field'); return; }
    const labelPrefix = addForm.labelPrefix.trim() || slugify(name);

    if (editingKey) {
      // Edit existing
      setCustomFields(prev => prev.map(f => f.key === editingKey ? {
        ...f,
        label:              fieldType === 'QTYPE_INT' ? `${name} (${cols} cột)` : `${name} (${rows} câu)`,
        shortLabel:         name,
        fieldType,
        rows,
        cols,
        labelPrefix,
        labelStart:         addForm.labelStart,
        includeInAnswerKey,
        group:              fieldType === 'QTYPE_INT' ? 'info' : 'mcq',
      } : f));
      // Update fieldStates dims
      setFieldStates(prev => {
        const old = prev[editingKey];
        if (!old) return prev;
        return { ...prev, [editingKey]: { ...old, rows, cols } };
      });
    } else {
      // Add new
      const key = `custom_${Date.now()}`;
      const color = CUSTOM_COLORS[customFields.length % CUSTOM_COLORS.length];
      const newDef: FieldDef = {
        key,
        label:              fieldType === 'QTYPE_INT' ? `${name} (${cols} cột)` : `${name} (${rows} câu)`,
        shortLabel:         name,
        group:              fieldType === 'QTYPE_INT' ? 'info' : 'mcq',
        fieldType,
        rows,
        cols,
        color,
        labelPrefix,
        labelStart:         addForm.labelStart,
        includeInAnswerKey,
        isPreset:           false,
      };
      setCustomFields(prev => [...prev, newDef]);
      setFieldStates(prev => ({ ...prev, [key]: initFm(newDef) }));
      // Auto-select first added field
      setCustomFields(prev2 => {
        if (prev2.length === 1) setCurFieldKey(prev2[0].key);
        return prev2;
      });
      // Simpler: just set if this is first field
      setCurFieldKey(k => k || key);
    }

    setShowAddModal(false);
  }

  function deleteField(key: string) {
    if (!window.confirm('Xóa field này?')) return;
    setCustomFields(prev => {
      const next = prev.filter(f => f.key !== key);
      // Update curFieldKey
      if (curFieldKey === key) {
        setCurFieldKey(next[0]?.key ?? '');
        setCurStep('roi'); setClicks([]);
      }
      return next;
    });
    setFieldStates(prev => { const n = { ...prev }; delete n[key]; return n; });
  }

  function duplicateField(def: FieldDef) {
    const key = `custom_${Date.now()}`;
    const color = CUSTOM_COLORS[customFields.length % CUSTOM_COLORS.length];
    const newDef: FieldDef = { ...def, key, shortLabel: def.shortLabel + ' (bản sao)', label: def.label + ' (bản sao)', color, isPreset: false };
    setCustomFields(prev => [...prev, newDef]);
    setFieldStates(prev => ({ ...prev, [key]: { ...initFm(newDef), ...(fieldStates[def.key] ?? {}) } }));
  }

  // ── Step helpers ──────────────────────────────────────────────────────────
  function goToStep(step: PickStep) { setCurStep(step); setClicks([]); }
  function setSubMode(mode: SubMode) { setSubModeState(mode); setClicks([]); }

  function resetStep() {
    setClicks([]);
    setFieldStates(prev => {
      const fm = prev[curFieldKey];
      if (!fm) return prev;
      let patch: Partial<FieldMeasurement>;
      if (curStep === 'roi') {
        patch = { box: null, origin: null, bubbleDimensions: null, hgap: null, vgap: null };
        setStepDetails({}); setStepWarns({});
      } else if (curStep === 'box') {
        patch = { origin: null, bubbleDimensions: null, hgap: null, vgap: null };
        setStepDetails({}); setStepWarns({});
      } else if (curStep === 'hgap') {
        patch = { hgap: null, vgap: null };
        setStepDetails(p => { const n = { ...p }; delete n['hgap']; delete n['vgap']; return n; });
        setStepWarns(p => { const n = { ...p }; delete n['hgap']; delete n['vgap']; return n; });
      } else if (curStep === 'vgap' || curStep === 'done') {
        patch = { vgap: null };
        setStepDetails(p => { const n = { ...p }; delete n['vgap']; return n; });
        setStepWarns(p => { const n = { ...p }; delete n['vgap']; return n; });
        setCurStep('vgap');
        return { ...prev, [curFieldKey]: { ...fm, vgap: null } };
      } else {
        return prev;
      }
      return { ...prev, [curFieldKey]: { ...fm, ...patch } };
    });
  }

  function goBack() {
    if (curStep === 'box')       goToStep('roi');
    else if (curStep === 'hgap') goToStep('box');
    else if (curStep === 'vgap') goToStep('hgap');
    else if (curStep === 'done') goToStep('vgap');
  }

  function resetField() {
    setFieldStates(prev => ({ ...prev, [curFieldKey]: initFm(curDef) }));
    setStepDetails({}); setStepWarns({}); goToStep('roi');
  }

  function setFmPartial(key: string, patch: Partial<FieldMeasurement>) {
    setFieldStates(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function switchField(key: string) {
    setCurFieldKey(key); setClicks([]); setStepDetails({}); setStepWarns({});
    const fm = fieldStates[key];
    if (!fm || !fm.box)         setCurStep('roi');
    else if (!fm.origin)        setCurStep('box');
    else if (fm.hgap == null)   setCurStep('hgap');
    else if (fm.vgap == null)   setCurStep('vgap');
    else                        setCurStep('done');
  }

  function commitStep() {
    const fm = fieldStates[curFieldKey];
    if (!fm) return;
    if ((curStep === 'hgap' || curStep === 'vgap') && clicks.length >= 2) {
      const axis = curStep === 'hgap' ? 'x' : 'y';
      const N    = curStep === 'hgap' ? fm.cols : fm.rows;
      let gap: number, refinedStart: number | null = null, detail: string;

      if (subMode === 'firstlast') {
        const last = clicks[clicks.length - 1], first = clicks[0];
        const dist = axis === 'x' ? last.x - first.x : last.y - first.y;
        gap = dist / Math.max(N - 1, 1);
        refinedStart = axis === 'x' ? first.x : first.y;
        detail = `First-Last: ${fmt2(gap)}px/khoảng`;
      } else {
        const xs = clicks.map((_, i) => i);
        const ys = clicks.map(pt => axis === 'x' ? pt.x : pt.y);
        const { a, b, maxErr } = linReg(xs, ys);
        gap = b; refinedStart = a;
        detail = `Regression: ${fmt2(b)}px (sai số max: ${fmt2(maxErr)}px)`;
        if (maxErr > 1) setStepWarns(p => ({ ...p, [curStep]: `⚠ Sai số ${fmt2(maxErr)}px — thử click chính xác hơn` }));
      }

      const patch: Partial<FieldMeasurement> = curStep === 'hgap' ? { hgap: gap } : { vgap: gap };
      if (refinedStart != null && fm.origin && fm.bubbleDimensions) {
        const bHalf = axis === 'x' ? fm.bubbleDimensions[0] / 2 : fm.bubbleDimensions[1] / 2;
        const refined = r2(refinedStart - bHalf);
        patch.origin = axis === 'x' ? [refined, fm.origin[1]] : [fm.origin[0], refined];
      }

      setStepDetails(p => ({ ...p, [curStep]: detail }));
      setFmPartial(curFieldKey, patch);
      setClicks([]);
      goToStep(curStep === 'hgap' ? 'vgap' : 'done');
    }
  }

  // ── Fine-tune ─────────────────────────────────────────────────────────────
  function ftAdj(what: string, delta: number) {
    setFieldStates(prev => {
      const fm = { ...prev[curFieldKey] }; if (!fm) return prev;
      if      (what === 'ox'   && fm.origin)           fm.origin           = [r2(fm.origin[0] + delta), fm.origin[1]];
      else if (what === 'oy'   && fm.origin)           fm.origin           = [fm.origin[0], r2(fm.origin[1] + delta)];
      else if (what === 'hgap' && fm.hgap != null)     fm.hgap             = r2(fm.hgap + delta);
      else if (what === 'vgap' && fm.vgap != null)     fm.vgap             = r2(fm.vgap + delta);
      else if (what === 'bw'   && fm.bubbleDimensions) fm.bubbleDimensions = [fm.bubbleDimensions[0] + delta, fm.bubbleDimensions[1]];
      else if (what === 'bh'   && fm.bubbleDimensions) fm.bubbleDimensions = [fm.bubbleDimensions[0], fm.bubbleDimensions[1] + delta];
      else return prev;
      return { ...prev, [curFieldKey]: fm };
    });
  }

  // ── Canvas handlers ───────────────────────────────────────────────────────
  function toPageCoords(e: React.MouseEvent<HTMLCanvasElement>): [number, number] {
    const c = canvasRef.current; if (!c) return [0, 0];
    const rect = c.getBoundingClientRect();
    return [
      Math.round((e.clientX - rect.left) * (pageDims[0] / c.clientWidth)),
      Math.round((e.clientY - rect.top)  * (pageDims[1] / c.clientHeight)),
    ];
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const pos = toPageCoords(e);
    hoverPosRef.current = pos;
    if (cursorRef.current) cursorRef.current.textContent = `x: ${pos[0]}  y: ${pos[1]}`;
    if ((curStep === 'roi' || curStep === 'box') && clicks.length === 1) doRedraw();
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!hasActiveFields || !curDef) return;
    const [rx, ry] = toPageCoords(e);
    const newClicks = [...clicks, { x: rx, y: ry }];
    if (curStep === 'roi' || curStep === 'box') {
      if (newClicks.length === 2) {
        const x1 = Math.min(newClicks[0].x, newClicks[1].x), y1 = Math.min(newClicks[0].y, newClicks[1].y);
        const x2 = Math.max(newClicks[0].x, newClicks[1].x), y2 = Math.max(newClicks[0].y, newClicks[1].y);
        if (curStep === 'roi') {
          setFmPartial(curFieldKey, { box: [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)] });
          goToStep('box');
        } else {
          setFmPartial(curFieldKey, {
            origin: [Math.round(x1), Math.round(y1)],
            bubbleDimensions: [Math.round(x2 - x1), Math.round(y2 - y1)],
          });
          goToStep('hgap');
        }
      } else { setClicks(newClicks); }
    } else if (curStep === 'hgap' || curStep === 'vgap') {
      setClicks(newClicks);
    }
  }

  function handleMouseLeave() { hoverPosRef.current = null; }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'Escape') { resetStep(); return; }
      if (e.key === 'Enter' && (curStep === 'hgap' || curStep === 'vgap')) { commitStep(); return; }
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setClicks(p => p.slice(0, -1)); return; }
      const d = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); ftAdj('ox', -d); }
      if (e.key === 'ArrowRight') { e.preventDefault(); ftAdj('ox', +d); }
      if (e.key === 'ArrowUp')    { e.preventDefault(); ftAdj('oy', -d); }
      if (e.key === 'ArrowDown')  { e.preventDefault(); ftAdj('oy', +d); }
      if (e.key === '+' || e.key === '=') setZoom(z => Math.min(4, r2(z + 0.1)));
      if (e.key === '-')               setZoom(z => Math.max(0.15, r2(z - 0.1)));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Image upload ──────────────────────────────────────────────────────────
  async function handleImageUpload(file: File) {
    let imageFile: File = file;
    if (file.type === 'application/pdf') {
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await requestRaw('/api/v1/custom-forms/pdf-preview', { method: 'POST', body: fd });
        if (res.ok) {
          const d = await res.json() as { image?: string; mime?: string };
          if (d.image) {
            const mimeType = d.mime ?? 'image/png';
            const byteStr  = atob(d.image);
            const ab = new ArrayBuffer(byteStr.length);
            const ua = new Uint8Array(ab);
            for (let i = 0; i < byteStr.length; i++) ua[i] = byteStr.charCodeAt(i);
            imageFile = new File([ab], 'page.png', { type: mimeType });
          }
        }
      } catch { /* keep original */ }
    }

    const fd2 = new FormData(); fd2.append('file', imageFile);
    try {
      const res2 = await requestRaw('/api/v1/custom-forms/align-image', { method: 'POST', body: fd2 });
      if (res2.ok) {
        const d2 = await res2.json() as { image?: string; mime?: string; align_method?: string };
        if (d2.image) {
          setImgSrc(`data:${d2.mime ?? 'image/jpeg'};base64,${d2.image}`);
          const m = d2.align_method;
          setAlignMethod(m === 'markers' || m === 'croppage' || m === 'none' ? m : null);
          return;
        }
      }
    } catch { /* fallback */ }

    setAlignMethod(null);
    setImgSrc(URL.createObjectURL(imageFile));
  }

  // ── Save / Export / Import ────────────────────────────────────────────────
  function buildAreas() {
    return activeFields
      .filter(def => { const fm = fieldStates[def.key]; return fm?.origin && fm.bubbleDimensions; })
      .map(def => fieldToPayload(def, fieldStates[def.key], pageDims));
  }

  async function saveTemplate() {
    const areas = buildAreas();
    if (!areas.length) { alert('Chưa đo field nào — cần đo ít nhất origin + kích thước bubble.'); return; }
    if (!templateName.trim()) { alert('Vui lòng nhập tên template'); return; }
    if (completedCount < activeFields.length) {
      const ok = window.confirm(`Bạn mới đo xong ${completedCount}/${activeFields.length} field. Vẫn lưu template?`);
      if (!ok) return;
    }
    setSaving(true); setSaveMsg('');
    try {
      const compilePayload: Record<string, unknown> = {
        name: templateName, pageDimensions: pageDims, areas, use_crop_on_markers: false,
      };
      if (editingTemplateId != null) compilePayload['template_id'] = editingTemplateId;
      const res = await requestRaw('/api/v1/custom-forms/compile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(compilePayload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { detail?: unknown };
        const d = err.detail;
        if (d && typeof d === 'object' && 'errors' in d) alert('Lỗi:\n' + (d as { errors: string[] }).errors.join('\n'));
        else alert(`Lỗi: ${typeof d === 'string' ? d : JSON.stringify(d)}`);
        return;
      }
      const data = await res.json() as { id: number; name: string };
      setSaveMsg(`✓ Đã lưu "${data.name}" (id=${data.id})`);
    } catch (err) { alert(`Lỗi khi lưu: ${String(err)}`); }
    finally { setSaving(false); }
  }

  function exportAreas() {
    const areas = buildAreas();
    const payload = {
      templateMode,
      templateName,
      pageDimensions: pageDims,
      ...(templateMode === 'custom' ? { fields: customFields } : {}),
      areas,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${templateName.replace(/\s+/g, '_')}_areas.json`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  function importAreas(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);
        // Support both wrapped format ({templateMode, areas}) and legacy flat array
        const isWrapped = !Array.isArray(raw) && raw !== null && typeof raw === 'object' && 'areas' in raw;
        const data: Array<Record<string, unknown>> = isWrapped ? raw.areas : raw;
        const mode: TemplateMode = isWrapped ? (raw.templateMode ?? 'vju_preset') : 'vju_preset';
        const importedCustomFields: FieldDef[] | null = isWrapped && mode === 'custom' ? raw.fields ?? null : null;

        if (!Array.isArray(data)) { alert('File phải có trường areas là JSON array'); return; }

        if (mode === 'custom' && importedCustomFields) {
          setTemplateMode('custom');
          setCustomFields(importedCustomFields);
          if (isWrapped && raw.templateName) setTemplateName(raw.templateName);

          const next: Record<string, FieldMeasurement> = { ...fieldStates };
          importedCustomFields.forEach(f => {
            const a = data.find(x => String(x.blockName ?? x.key) === f.key);
            if (a) {
              const isInt = f.fieldType === 'QTYPE_INT';
              const bg = Number(a.bubblesGap) || 0, lg = Number(a.labelsGap) || 0;
              next[f.key] = {
                box:              Array.isArray(a.box)              ? (a.box as [number,number,number,number]) : null,
                origin:           Array.isArray(a.origin)           ? (a.origin as [number,number]) : null,
                bubbleDimensions: Array.isArray(a.bubbleDimensions) ? (a.bubbleDimensions as [number,number]) : null,
                hgap: isInt ? lg : bg,
                vgap: isInt ? bg : lg,
                rows: Number(a.physicalRows) || f.rows,
                cols: Number(a.physicalCols) || f.cols,
              };
            } else {
              next[f.key] = initFm(f);
            }
          });
          setFieldStates(next);
          setCurFieldKey(importedCustomFields[0]?.key ?? '');
          setCurStep('roi'); setClicks([]);
          setSaveMsg(`✓ Đã import ${data.length} fields (custom mode)`);

        } else {
          // VJU preset
          setTemplateMode('vju_preset');
          if (isWrapped && raw.templateName) setTemplateName(raw.templateName);
          const next = { ...fieldStates };
          let loaded = 0;
          data.forEach(a => {
            const key = String(a.blockName ?? a.key ?? '');
            const def = VJU_FIELDS.find(f => f.key === key); if (!def) return;
            const isInt = def.fieldType === 'QTYPE_INT';
            const bg = Number(a.bubblesGap) || 0, lg = Number(a.labelsGap) || 0;
            const hgap = isInt ? lg : bg, vgap = isInt ? bg : lg;
            next[key] = {
              box:              Array.isArray(a.box)              ? (a.box as [number,number,number,number]) : null,
              origin:           Array.isArray(a.origin)           ? (a.origin as [number,number]) : null,
              bubbleDimensions: Array.isArray(a.bubbleDimensions) ? (a.bubbleDimensions as [number,number]) : null,
              hgap, vgap,
              rows: Number(a.physicalRows) || def.rows,
              cols: Number(a.physicalCols) || def.cols,
            };
            loaded++;
          });
          setFieldStates(next);
          setCurFieldKey(VJU_FIELDS[0].key);
          setCurStep('roi'); setClicks([]);
          setSaveMsg(`✓ Đã import ${loaded} fields (VJU preset)`);
        }
      } catch { alert('File JSON không hợp lệ'); }
    };
    reader.readAsText(file); e.target.value = '';
  }

  // ── Derived UI ────────────────────────────────────────────────────────────
  const canGoBack     = curStep !== 'roi';
  const showCommitBtn = (curStep === 'hgap' || curStep === 'vgap') && clicks.length >= 2;
  const hasGrid       = !!(curFm?.origin && curFm.bubbleDimensions);
  const isInt         = curDef?.fieldType === 'QTYPE_INT';
  const guide         = curDef ? getStepGuide(curDef, curStep, clicks.length, subMode) : null;
  const typeLabel     = isInt ? 'Dạng số' : 'Dạng A/B/C/D';
  const sizeLabel     = isInt
    ? `${curFm?.cols ?? '?'} cột × ${curFm?.rows ?? '?'} hàng`
    : `${curFm?.rows ?? '?'} câu × ${curFm?.cols ?? '?'} lựa chọn`;
  const stepNum = curStep ? STEP_NUM[curStep] : 1;

  // ── Style constants ───────────────────────────────────────────────────────
  const ftBtn: React.CSSProperties = {
    width: 24, height: 24, borderRadius: 4, border: '1px solid #E5E7EB',
    background: '#F9FAFB', color: '#374151', cursor: 'pointer',
    fontSize: 15, fontWeight: 700, lineHeight: '1', padding: 0,
  };
  const subBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '5px 0', borderRadius: 6, fontSize: 11, fontWeight: 700,
    border: `1.5px solid ${active ? curDef.color : '#E5E7EB'}`,
    color: active ? curDef.color : '#6B7280',
    background: active ? curDef.color + '14' : '#F9FAFB',
    cursor: 'pointer', fontFamily: 'inherit',
  });
  const modeBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
    border: `1.5px solid ${active ? '#C8102E' : '#E5E7EB'}`,
    background: active ? '#C8102E' : '#F9FAFB',
    color: active ? '#fff' : '#6B7280',
    cursor: 'pointer', fontFamily: 'inherit', transition: 'all .15s',
  });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title={isEditMode ? 'Sửa Template Tọa Độ' : 'Tạo Template Tọa Độ'}
        subtitle={`${completedCount}/${activeFields.length} field hoàn tất · ${templateName}`}
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

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* ═══ LEFT: Canvas ═══════════════════════════════════════════════════ */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>

          {/* Top bar */}
          <div style={{ padding: '8px 16px', borderBottom: '1px solid #E5E7EB', background: '#fff', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Mode toggle */}
            <div style={{ display: 'flex', gap: 3, background: '#F1F5F9', borderRadius: 8, padding: 3 }}>
              <button style={modeBtn(templateMode === 'vju_preset')} onClick={() => switchTemplateMode('vju_preset')}>
                VJU preset
              </button>
              <button style={modeBtn(templateMode === 'custom')} onClick={() => switchTemplateMode('custom')}>
                Custom template
              </button>
            </div>

            {/* Template selector */}
            <select
              value={editingTemplateId != null ? String(editingTemplateId) : '__new__'}
              onChange={e => { void handleSelectTemplate(e.target.value); }}
              disabled={templatesLoading}
              style={{ padding: '5px 8px', borderRadius: 7, border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'inherit', color: '#374151', background: '#fff', cursor: 'pointer', maxWidth: 200 }}
            >
              <option value="__new__">✦ Tạo template mới</option>
              {templates.map(t => (
                <option key={t.id} value={String(t.id)}>{t.name}</option>
              ))}
            </select>

            <input
              value={templateName}
              onChange={e => setTemplateName(e.target.value)}
              placeholder="Tên template"
              style={{ flex: '1 1 140px', padding: '5px 9px', borderRadius: 7, border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'inherit', outline: 'none' }}
            />
            <Button size="sm" icon={<FileImage size={13} />} variant="secondary" onClick={() => fileInputRef.current?.click()}>
              Upload ảnh/PDF
            </Button>
            <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); e.target.value = ''; }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#6B7280' }}>Zoom {Math.round(zoom * 100)}%</span>
              <input type="range" min={15} max={300} value={Math.round(zoom * 100)} step={5}
                onChange={e => setZoom(+e.target.value / 100)}
                style={{ width: 80, accentColor: '#C8102E' }} />
              <button onClick={fitPage} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, border: '1.5px solid #E5E7EB', background: '#F9FAFB', color: '#374151', cursor: 'pointer', fontFamily: 'inherit' }}>
                Fit page
              </button>
            </div>
            {saveMsg && <div style={{ fontSize: 11, color: '#065F46', background: '#D1FAE5', padding: '4px 10px', borderRadius: 6 }}>{saveMsg}</div>}
            {alignMethod === 'markers' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, background: '#D1FAE5', border: '1px solid #6EE7B7' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#065F46' }}>✓ Căn bằng marker</span>
                <span style={{ fontSize: 10, color: '#047857' }}>· {pageDims[0]}×{pageDims[1]}</span>
              </div>
            )}
            {alignMethod === 'croppage' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, background: '#FEF9C3', border: '1px solid #FDE047' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#854D0E' }}>⚠ CropPage fallback</span>
                <span style={{ fontSize: 10, color: '#78350F' }}>· {pageDims[0]}×{pageDims[1]}</span>
              </div>
            )}
            {alignMethod === 'none' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '5px 10px', borderRadius: 6, background: '#FEE2E2', border: '1px solid #FCA5A5' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#991B1B' }}>✗ Không detect được marker/crop</span>
                <span style={{ fontSize: 10, color: '#7F1D1D' }}>Template có thể lệch. Hãy dùng ảnh scan rõ 4 marker.</span>
              </div>
            )}
          </div>

          {/* Canvas */}
          <div ref={canvasContainerRef} style={{ flex: 1, overflow: 'auto', background: '#f4f5f7', position: 'relative' }}>
            <canvas
              ref={canvasRef}
              onClick={handleClick}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              style={{ display: 'block', cursor: hasActiveFields ? 'crosshair' : 'default' }}
            />

            {/* Empty-state overlay — shown until image is loaded */}
            {!imgSrc && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
              }}>
                <div style={{
                  background: '#ffffff',
                  border: `1.5px solid ${isEditMode ? '#FDE68A' : '#e5e7eb'}`,
                  borderRadius: 16,
                  padding: '32px 40px',
                  textAlign: 'center',
                  boxShadow: '0 4px 24px rgba(15,23,42,0.08)',
                  maxWidth: 360,
                  pointerEvents: 'auto',
                }}>
                  <div style={{ fontSize: 40, marginBottom: 12, lineHeight: 1 }}>{isEditMode ? '🗂️' : '📄'}</div>
                  {isEditMode ? (
                    <>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#92400E', marginBottom: 8 }}>
                        Template đã được tải
                      </div>
                      <div style={{ fontSize: 12, color: '#78350F', lineHeight: 1.7, marginBottom: 16, background: '#FEF3C7', padding: '10px 14px', borderRadius: 8 }}>
                        Hãy upload ảnh hoặc PDF cùng loại phiếu để overlay và chỉnh sửa tọa độ.
                        Các vùng đã define sẽ hiển thị lên ảnh.
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#1a1a1a', marginBottom: 6 }}>Chưa có ảnh</div>
                      <div style={{ fontSize: 12, color: '#71717a', lineHeight: 1.6, marginBottom: 16 }}>
                        Upload ảnh hoặc PDF để bắt đầu<br />tạo template tọa độ
                      </div>
                    </>
                  )}
                  <button onClick={() => fileInputRef.current?.click()} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '8px 18px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                    border: '2px solid #C8102E', background: '#C8102E', color: '#fff',
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                    <Upload size={13} /> Upload ảnh / PDF
                  </button>
                </div>
              </div>
            )}

            <div style={{ position: 'sticky', bottom: 0, padding: '3px 12px', background: 'rgba(255,255,255,0.92)', borderTop: '1px solid #e5e7eb', fontSize: 10, fontFamily: 'monospace', display: 'flex', justifyContent: 'space-between' }}>
              <span ref={cursorRef} style={{ color: '#1B5E20', fontWeight: 600 }}>x: —  y: —</span>
              <span style={{ color: '#64748b' }}>
                {pageDims[0]}×{pageDims[1]}px · Esc=reset · Ctrl+Z=undo · ±=zoom
              </span>
            </div>
          </div>
        </div>

        {/* ═══ RIGHT: Wizard panel ════════════════════════════════════════════ */}
        <div style={{ width: 320, flexShrink: 0, borderLeft: '1px solid #E5E7EB', background: '#F8FAFC', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 0' }}>

            {/* ── No fields placeholder (custom mode, empty) ─────────────── */}
            {!hasActiveFields && templateMode === 'custom' && (
              <Card style={{ padding: '24px 16px', textAlign: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Chưa có field nào</div>
                <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 16, lineHeight: 1.5 }}>
                  Thêm field để bắt đầu đo tọa độ cho template của bạn.
                </div>
                <button onClick={openAddModal} style={{
                  padding: '9px 20px', borderRadius: 8, fontSize: 13, fontWeight: 700,
                  border: 'none', background: '#C8102E', color: '#fff', cursor: 'pointer', fontFamily: 'inherit',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                  <Plus size={14} /> Thêm field đầu tiên
                </button>
              </Card>
            )}

            {/* ── Wizard (only when there are fields) ───────────────────── */}
            {hasActiveFields && curDef && (
              <>
                {/* 1. Field info */}
                <Card style={{ padding: '12px 14px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, background: curDef.color, marginTop: 3, boxShadow: `0 0 6px ${curDef.color}88` }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', lineHeight: 1.2 }}>{curDef.shortLabel}</div>
                      <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{typeLabel} · {sizeLabel}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
                        {['Khoanh vùng', 'Đo bubble', 'Đo ngang', 'Đo dọc'].map((s, i) => {
                          const n  = i + 1;
                          const done   = (n === 1 && !!curFm?.box) || (n === 2 && !!curFm?.origin) || (n === 3 && curFm?.hgap != null) || (n === 4 && curFm?.vgap != null);
                          const active = (curStep === 'roi' && n === 1) || (curStep === 'box' && n === 2) || (curStep === 'hgap' && n === 3) || ((curStep === 'vgap' || curStep === 'done') && n === 4);
                          return (
                            <div key={s} title={s} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                              <div style={{ width: 24, height: 24, borderRadius: '50%', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', background: done ? '#059669' : active ? curDef.color : '#E5E7EB', color: done || active ? '#fff' : '#9CA3AF' }}>
                                {done ? '✓' : n}
                              </div>
                              {i < 3 && <div style={{ width: 14, height: 2, background: done ? '#059669' : '#E5E7EB', borderRadius: 1 }} />}
                            </div>
                          );
                        })}
                        <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 4 }}>
                          {curStep === 'done' ? 'Hoàn tất' : `Bước ${stepNum}/${TOTAL_STEPS}`}
                        </span>
                      </div>
                    </div>
                  </div>
                </Card>

                {/* 2. Step guide */}
                {guide && (
                  <Card style={{ padding: '14px', marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 10 }}>{guide.title}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                      {guide.instructions.map((line, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          {line.startsWith('①') || line.startsWith('②') || line.startsWith('✅') ? null : (
                            <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#94A3B8', flexShrink: 0, marginTop: 7 }} />
                          )}
                          <span style={{ fontSize: 12, color: line.startsWith('✅') ? '#059669' : '#374151', lineHeight: 1.5, flex: 1 }}>{line}</span>
                        </div>
                      ))}
                    </div>

                    {guide.clickGoal && curStep !== 'done' && (
                      <div style={{ background: curDef.color + '14', border: `1.5px solid ${curDef.color}44`, borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12, fontWeight: 600, color: curDef.color }}>
                        📍 {guide.clickGoal}
                        {clicks.length > 0 && <span style={{ fontWeight: 400, color: '#6B7280', marginLeft: 8 }}>(đã click {clicks.length} · Ctrl+Z hủy)</span>}
                      </div>
                    )}

                    {(curStep === 'hgap' || curStep === 'vgap') && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, color: '#6B7280', fontWeight: 600, marginBottom: 5 }}>Cách đo:</div>
                        <div style={{ display: 'flex', gap: 5 }}>
                          <button style={subBtn(subMode === 'firstlast')} onClick={() => setSubMode('firstlast')}>⊣⊢ Đầu & Cuối</button>
                          <button style={subBtn(subMode === 'multi')}     onClick={() => setSubMode('multi')}>∿ Nhiều điểm</button>
                        </div>
                        <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 4 }}>
                          {subMode === 'firstlast' ? 'Click 2 điểm — hệ thống chia đều khoảng cách' : 'Click ≥2 điểm → Enter/nút Xác nhận'}
                        </div>
                      </div>
                    )}

                    {showCommitBtn && (
                      <button onClick={commitStep} style={{ width: '100%', padding: '9px 0', borderRadius: 8, fontSize: 13, fontWeight: 700, border: `2px solid ${curDef.color}`, color: '#fff', background: curDef.color, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 8 }}>
                        ✓ Xác nhận {curStep === 'hgap' ? 'khoảng cách ngang' : 'khoảng cách dọc'} ({clicks.length} điểm)
                      </button>
                    )}

                    {(stepDetails['hgap'] || stepDetails['vgap']) && curStep === 'done' && (
                      <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#059669', background: '#F0FDF4', borderRadius: 6, padding: '6px 8px', marginBottom: 8 }}>
                        {stepDetails['hgap'] && <div>↔ {stepDetails['hgap']}</div>}
                        {stepDetails['vgap'] && <div>↕ {stepDetails['vgap']}</div>}
                      </div>
                    )}
                    {(stepWarns['hgap'] || stepWarns['vgap']) && (
                      <div style={{ fontSize: 10, color: '#D97706', marginBottom: 8 }}>{stepWarns['hgap']} {stepWarns['vgap']}</div>
                    )}

                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      {canGoBack && (
                        <button onClick={goBack} style={{ flex: 1, padding: '7px 0', borderRadius: 7, fontSize: 12, fontWeight: 600, border: '1.5px solid #E5E7EB', color: '#374151', background: '#F9FAFB', cursor: 'pointer', fontFamily: 'inherit' }}>
                          ← Quay lại
                        </button>
                      )}
                      <button onClick={resetStep} style={{ flex: 1, padding: '7px 0', borderRadius: 7, fontSize: 12, fontWeight: 600, border: '1.5px solid #E5E7EB', color: '#374151', background: '#F9FAFB', cursor: 'pointer', fontFamily: 'inherit' }}>
                        ↺ Reset bước
                      </button>
                      {curStep === 'done' && (
                        <button onClick={resetField} style={{ flex: 1, padding: '7px 0', borderRadius: 7, fontSize: 12, fontWeight: 600, border: '1.5px solid #FECACA', color: '#C8102E', background: '#FEF2F2', cursor: 'pointer', fontFamily: 'inherit' }}>
                          Đo lại
                        </button>
                      )}
                    </div>
                  </Card>
                )}

                {/* 3. Advanced */}
                <div style={{ marginBottom: 10, border: '1.5px solid #E5E7EB', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
                  <button onClick={() => setShowAdvanced(v => !v)} style={{ width: '100%', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: '#374151' }}>
                    {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Chi tiết kỹ thuật
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: '#9CA3AF', fontWeight: 400 }}>{hasGrid ? 'Có dữ liệu' : 'Chưa đo'}</span>
                  </button>
                  {showAdvanced && (
                    <div style={{ padding: '0 14px 14px', borderTop: '1px solid #F1F5F9' }}>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#6B7280' }}>Hàng:</span>
                        <input type="number" min={1} max={80} value={curFm?.rows ?? 1}
                          onChange={e => setFmPartial(curFieldKey, { rows: parseInt(e.target.value) || 1 })}
                          style={{ width: 50, padding: '4px 7px', borderRadius: 6, border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
                        <span style={{ fontSize: 11, color: '#6B7280' }}>Cột:</span>
                        <input type="number" min={1} max={30} value={curFm?.cols ?? 1}
                          onChange={e => setFmPartial(curFieldKey, { cols: parseInt(e.target.value) || 1 })}
                          style={{ width: 50, padding: '4px 7px', borderRadius: 6, border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
                        <span style={{ fontSize: 10, background: '#FEF2F2', color: '#C8102E', padding: '2px 7px', borderRadius: 10, fontWeight: 700 }}>
                          {curDef.fieldType.replace('QTYPE_', '')}
                        </span>
                      </div>
                      {hasGrid && (
                        <div style={{ marginTop: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Chỉnh tinh (← → ↑ ↓ · Shift×5)</div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                            {([
                              ['ox',   'Vị trí X',    curFm?.origin?.[0]],
                              ['oy',   'Vị trí Y',    curFm?.origin?.[1]],
                              ['hgap', 'Gap ngang',   curFm?.hgap],
                              ['vgap', 'Gap dọc',     curFm?.vgap],
                              ['bw',   'Rộng bubble', curFm?.bubbleDimensions?.[0]],
                              ['bh',   'Cao bubble',  curFm?.bubbleDimensions?.[1]],
                            ] as [string, string, number | undefined][]).map(([what, lbl, val]) => (
                              <div key={what} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                <span style={{ fontSize: 10, color: '#6B7280', flex: 1 }}>{lbl}</span>
                                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#D97706', minWidth: 38, textAlign: 'right' }}>{fmt2(val)}</span>
                                <button style={ftBtn} onClick={() => ftAdj(what, -0.5)}>−</button>
                                <button style={ftBtn} onClick={() => ftAdj(what, +0.5)}>+</button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {hasGrid && (
                        <div style={{ marginTop: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>JSON — {curDef.key}</div>
                          <pre style={{ fontSize: 9, fontFamily: 'monospace', background: '#0F172A', color: '#4ADE80', borderRadius: 6, padding: '6px 8px', overflow: 'auto', lineHeight: 1.5, margin: 0, maxHeight: 200 }}>
                            {JSON.stringify(fieldToPayload(curDef, curFm, pageDims), null, 2)}
                          </pre>
                          <button onClick={() => navigator.clipboard.writeText(JSON.stringify(fieldToPayload(curDef, curFm, pageDims), null, 2)).catch(() => null)}
                            style={{ marginTop: 5, width: '100%', padding: '4px 0', borderRadius: 6, fontSize: 10, fontWeight: 600, border: '1.5px solid #0284C7', color: '#0284C7', background: '#F0F9FF', cursor: 'pointer', fontFamily: 'inherit' }}>
                            Copy JSON
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ── 4. Field checklist ─────────────────────────────────────── */}
            <div style={{ marginBottom: 10, border: '1.5px solid #E5E7EB', borderRadius: 10, overflow: 'hidden', background: '#fff', padding: '12px 14px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Tất cả fields</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: completedCount === activeFields.length && activeFields.length > 0 ? '#059669' : '#9CA3AF' }}>
                    {completedCount}/{activeFields.length} xong
                  </span>
                  {templateMode === 'custom' && (
                    <button onClick={openAddModal} style={{ padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, border: '1.5px solid #C8102E', color: '#C8102E', background: '#FEF2F2', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Plus size={10} /> Thêm
                    </button>
                  )}
                </div>
              </div>

              {templateMode === 'vju_preset' ? (
                (['info', 'mcq'] as const).map(group => (
                  <div key={group}>
                    <div style={{ fontSize: 9, color: '#9CA3AF', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, marginTop: group === 'mcq' ? 10 : 0 }}>
                      {group === 'info' ? 'Thông tin' : 'Bài thi'}
                    </div>
                    {VJU_FIELDS.filter(f => f.group === group).map(def => {
                      const fm     = fieldStates[def.key];
                      const done   = isComplete(fm ?? initFm(def));
                      const active = def.key === curFieldKey;
                      return (
                        <div key={def.key} onClick={() => switchField(def.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 7, marginBottom: 2, cursor: 'pointer', background: active ? def.color + '12' : 'transparent', border: `1.5px solid ${active ? def.color + '44' : 'transparent'}` }}>
                          <span style={{ fontSize: 14, lineHeight: 1 }}>{done ? '✅' : active ? '📍' : '○'}</span>
                          <span style={{ flex: 1, fontSize: 12, color: active ? def.color : '#374151', fontWeight: active ? 700 : 400 }}>{def.shortLabel}</span>
                          <span style={{ fontSize: 10, fontWeight: 600, color: done ? '#059669' : active ? curDef.color : '#9CA3AF' }}>
                            {done ? 'Xong' : active ? 'Đang đo' : 'Chưa đo'}
                          </span>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: def.color + (done ? '' : '44'), flexShrink: 0 }} />
                        </div>
                      );
                    })}
                  </div>
                ))
              ) : (
                <>
                  {customFields.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '12px 0', color: '#9CA3AF', fontSize: 12 }}>
                      Chưa có field — bấm "+ Thêm" để bắt đầu
                    </div>
                  )}
                  {customFields.map(def => {
                    const fm     = fieldStates[def.key];
                    const done   = isComplete(fm ?? initFm(def));
                    const active = def.key === curFieldKey;
                    return (
                      <div key={def.key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 7, marginBottom: 2, background: active ? def.color + '12' : 'transparent', border: `1.5px solid ${active ? def.color + '44' : 'transparent'}` }}>
                        <div onClick={() => switchField(def.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer' }}>
                          <span style={{ fontSize: 14, lineHeight: 1 }}>{done ? '✅' : active ? '📍' : '○'}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, color: active ? def.color : '#374151', fontWeight: active ? 700 : 400 }}>{def.shortLabel}</div>
                            <div style={{ fontSize: 10, color: '#9CA3AF' }}>{def.fieldType === 'QTYPE_INT' ? `Dạng số · ${def.cols} cột` : `A/B/C/D · ${def.rows} câu`}</div>
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 600, color: done ? '#059669' : active ? def.color : '#9CA3AF' }}>
                            {done ? 'Xong' : active ? 'Đang đo' : 'Chưa đo'}
                          </span>
                        </div>
                        {/* Edit / Duplicate / Delete */}
                        <div style={{ display: 'flex', gap: 2 }}>
                          <button onClick={() => openEditModal(def)} title="Sửa" style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid #E5E7EB', background: '#F9FAFB', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                            <Edit2 size={11} color="#6B7280" />
                          </button>
                          <button onClick={() => duplicateField(def)} title="Nhân bản" style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid #E5E7EB', background: '#F9FAFB', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, fontSize: 11 }}>
                            ⊕
                          </button>
                          <button onClick={() => deleteField(def.key)} title="Xóa" style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid #FECACA', background: '#FEF2F2', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                            <Trash2 size={11} color="#C8102E" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>

          </div>{/* end scroll */}

          {/* ── Fixed bottom ─────────────────────────────────────────────── */}
          <div style={{ padding: '10px 12px', borderTop: '1px solid #E5E7EB', background: '#fff', display: 'flex', gap: 8 }}>
            <button onClick={exportAreas} style={{ flex: 1, padding: '9px 0', borderRadius: 8, fontSize: 12, fontWeight: 700, border: '1.5px solid #E5E7EB', color: '#374151', background: '#F9FAFB', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <Download size={13} /> Export JSON
            </button>
            <button onClick={saveTemplate} disabled={saving} style={{ flex: 1, padding: '9px 0', borderRadius: 8, fontSize: 12, fontWeight: 700, border: '2px solid #C8102E', color: '#fff', background: saving ? '#9CA3AF' : '#C8102E', cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <Save size={13} /> {saving ? 'Đang lưu…' : 'Save Template'}
            </button>
          </div>
        </div>
      </div>

      {/* ══ Add / Edit Field Modal ══════════════════════════════════════════════ */}
      {showAddModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowAddModal(false); }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', fontFamily: 'inherit' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 18 }}>
              {editingKey ? 'Sửa field' : 'Thêm field mới'}
            </div>

            {/* Name */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Tên field *</label>
              <input
                autoFocus value={addForm.name}
                onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                placeholder="VD: Mã sinh viên, Phần trắc nghiệm..."
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #E5E7EB', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>

            {/* Type */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Loại field</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['QTYPE_INT', 'QTYPE_MCQ4'] as const).map(ft => (
                  <button key={ft} onClick={() => setAddForm(f => ({ ...f, fieldType: ft, includeInAnswerKey: ft === 'QTYPE_MCQ4' }))}
                    style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 700, border: `2px solid ${addForm.fieldType === ft ? '#C8102E' : '#E5E7EB'}`, background: addForm.fieldType === ft ? '#FEF2F2' : '#F9FAFB', color: addForm.fieldType === ft ? '#C8102E' : '#6B7280', cursor: 'pointer', fontFamily: 'inherit' }}>
                    {ft === 'QTYPE_INT' ? '🔢 Dạng số' : '🅰 Dạng A/B/C/D'}
                  </button>
                ))}
              </div>
            </div>

            {/* Rows / Cols */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
                  {addForm.fieldType === 'QTYPE_INT' ? 'Số hàng (0–9)' : 'Số câu'}
                </label>
                <input type="number" min={1} max={100} value={addForm.rows}
                  onChange={e => setAddForm(f => ({ ...f, rows: parseInt(e.target.value) || 1 }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #E5E7EB', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
                  {addForm.fieldType === 'QTYPE_INT' ? 'Số cột' : 'Số đáp án'}
                </label>
                <input type="number" min={1} max={30} value={addForm.cols}
                  onChange={e => setAddForm(f => ({ ...f, cols: parseInt(e.target.value) || 1 }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #E5E7EB', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
              </div>
            </div>

            {/* Label prefix + start */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 2 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Label prefix</label>
                <input value={addForm.labelPrefix}
                  onChange={e => setAddForm(f => ({ ...f, labelPrefix: e.target.value }))}
                  placeholder={`(tự động: ${slugify(addForm.name || 'field')})`}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Bắt đầu từ</label>
                <input type="number" min={1} value={addForm.labelStart}
                  onChange={e => setAddForm(f => ({ ...f, labelStart: parseInt(e.target.value) || 1 }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #E5E7EB', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
              </div>
            </div>

            {/* Include in answer key */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, cursor: 'pointer' }}>
              <input type="checkbox" checked={addForm.includeInAnswerKey}
                onChange={e => setAddForm(f => ({ ...f, includeInAnswerKey: e.target.checked }))} />
              <span style={{ fontSize: 12, color: '#374151' }}>Tính điểm (include in answer key)</span>
            </label>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowAddModal(false)} style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1.5px solid #E5E7EB', color: '#374151', background: '#F9FAFB', cursor: 'pointer', fontFamily: 'inherit' }}>
                Hủy
              </button>
              <button onClick={saveField} style={{ flex: 2, padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 700, border: 'none', background: '#C8102E', color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
                {editingKey ? 'Lưu thay đổi' : '+ Thêm field'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
