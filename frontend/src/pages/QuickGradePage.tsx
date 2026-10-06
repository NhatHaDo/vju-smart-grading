/**
 * QuickGradePage.tsx — "Chấm nhanh liên tục" (2026-08-05)
 *
 * Yêu cầu gốc: "t muốn web của t có chức năng chấm nhanh... hiện điểm ngay
 * sau khi quét; hỗ trợ nhiều mã đề; có thể chấm tự động liên tiếp nhiều
 * phiếu; thời gian khoảng vài giây cho mỗi phiếu" (đối chiếu app chamthi.com).
 *
 * Khác với luồng chụp cũ (SheetReviewPage → CameraCaptureModal → AnswerKeyPage
 * → "Chấm ngay" chấm cả loạt cùng lúc), trang này:
 *   1. Dùng NGAY đáp án/mẫu phiếu đang active (đã lưu ở Answer Key) — không
 *      phải chọn lại mỗi lần.
 *   2. Camera tự nhận diện phiếu (tái dùng /omr/quick-check, cùng cơ chế
 *      "giữ yên 3 lần liên tiếp" như CameraCaptureModal) rồi CHẤM NGAY —
 *      không dừng lại ở bước xem trước/xác nhận ảnh (bỏ hẳn theo lựa chọn
 *      của người dùng, ưu tiên tốc độ).
 *   3. Điểm hiện ra ngay dưới dạng banner nổi trên khung hình — KHÔNG chặn
 *      camera — để người dùng tráo phiếu tiếp theo ngay trong lúc xem điểm.
 *   4. Kết thúc phiên → "Xong" điều hướng sang /app/results với đúng
 *      BatchGradeState mà trang đó đã biết cách tự lưu xuống DB (tái dùng
 *      logic saveBatch có sẵn ở ResultsPage, không viết lại).
 *
 * Cố tình là 1 trang HOÀN TOÀN RIÊNG — không sửa CameraCaptureModal.tsx hay
 * luồng Upload/Answer Key hiện có, theo đúng phạm vvi đã chọn.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, X, Hand, Camera as CameraIcon, ArrowLeft, AlertTriangle, CheckCircle2, ListChecks, Settings2, LayoutTemplate, FileUp, Download } from 'lucide-react';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import PageHeader from '../components/layout/PageHeader';
import { customFormsApi, examPapersApi, examsApi } from '../services/apiClient';
import type { ExamOut } from '../types/exam';
import { buildSchemaFromDetail } from '../utils/templateSchema';
import { maDeFromFileName, parseAnswerKeyWorkbook } from '../utils/answerKeyExcel';
import { saveAs } from 'file-saver';
import {
  loadAnswerKey,
  loadAnswerKeyDraft,
  loadAnswerKeyOwner,
  loadLastUsedTemplate,
  saveAnswerKey,
  saveAnswerKeyDraft,
  saveLastUsedTemplate,
  VJU_PRESET_SCHEMA,
  type TemplateSchema,
  templateStoreKeyFor,
  PINNED_TEMPLATES,
  VJU_SBD4_PREVIEW_IMAGE,
  VJU_SBD8_PREVIEW_IMAGE,
  isMultiMaDe,
  TEMPLATE_VARIANT_LABEL,
  DEFAULT_SCORING,
  sheetTemplate,
  type TemplateVariant,
  type OmrGradeResult,
  type BatchGradeState,
  type AnswerKeyStore,
  type LastUsedTemplate,
} from '../types/grading';

// Đường dẫn TƯƠNG ĐỐI, không phải VITE_API_BASE tuyệt đối — giống lý do đã
// ghi trong CameraCaptureModal.tsx: test qua cloudflared trên điện thoại thì
// "localhost" tuyệt đối trỏ nhầm vào chính điện thoại. Trang này luôn dùng
// camera nên luôn cần đường dẫn tương đối qua đúng proxy /api.
const GRADE_URL      = '/api/v1/omr/debug-grade';
const QUICK_CHECK_URL = '/api/v1/omr/quick-check';

const POLL_INTERVAL_MS   = 450;
const READY_STREAK_NEEDED = 3;
const QUICK_CHECK_WIDTH   = 480;
/** Banner điểm tự ẩn sau chừng này nếu không có kết quả mới đè lên. */
const RESULT_BANNER_MS = 4000;

type AutoState = 'searching' | 'holding' | 'clearing';

// ── Nhận ra phiếu MỚI khi thầy cô đẩy phiếu tiếp theo lên (2026-10-06) ─────
// "lúc t chấm nhanh thì nó không tự chấm … việc của các thầy cô chỉ là giơ
// máy và đẩy phiếu lần lượt": after grading, the page used to wait for a
// frame with no sheet at all, which never comes when the next sheet slides on
// top. Now a sheet counts as new when its corners moved, or when its
// fingerprint (quick-check: the straightened sheet, printed form taken out)
// differs from the one just graded. Measured on 17 real Bộ GD photos: two
// different sheets are ≥ 0.114 apart, the same sheet under other light/
// angle/blur ≤ 0.116 (95%), so 0.11; the rare same-sheet miss is caught by
// the duplicate check after grading (same SBD, mã đề and answers = skipped).
const NEW_SHEET_FP_DIST   = 0.11;
/** A corner moved this much (share of the frame) since grading = sheet changed. */
const NEW_SHEET_MOVE      = 0.06;
/** Between two "ready" checks the corners must stay this still to count as held. */
const HOLD_STILL_MOVE     = 0.02;

interface QuickCheck { detected: boolean; ready: boolean; corners?: number[][]; fingerprint?: string }
interface SheetMark { corners: number[][]; fp: Float32Array | null }

function decodeFingerprint(b64: string | undefined): Float32Array | null {
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const v = new Float32Array(bin.length);
    let mean = 0;
    for (let i = 0; i < bin.length; i++) { v[i] = bin.charCodeAt(i) / 255 * 6 - 3; mean += v[i]; }
    mean /= v.length || 1;
    let sd = 0;
    for (let i = 0; i < v.length; i++) { v[i] -= mean; sd += v[i] * v[i]; }
    sd = Math.sqrt(sd / (v.length || 1)) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= sd;
    return v;
  } catch { return null; }
}

/** 1 − correlation of two fingerprints: ~0 same sheet, ≥ 0.11 another sheet. */
function fingerprintDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return 1 - s / a.length;
}

function cornerShift(a: number[][] | undefined, b: number[][] | undefined): number {
  if (!a || !b || a.length !== 4 || b.length !== 4) return 1;
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
}

/** Same SBD / mã đề and same answers read = the very sheet just graded. */
function sameReading(a: OmrGradeResult, b: OmrGradeResult): boolean {
  return JSON.stringify([a.student_info, a.answers]) === JSON.stringify([b.student_info, b.answers]);
}

function buildAnswerKeyPayload(store: AnswerKeyStore): Record<string, unknown> | null {
  if (isMultiMaDe(store)) {
    return {
      byMaDe: Object.fromEntries(
        Object.entries(store.byMaDe ?? {}).map(([maDe, set]) => [maDe, set.answers]),
      ),
      default: store.answers,
    };
  }
  return store.answers && Object.keys(store.answers).length > 0 ? store.answers : null;
}

function scorePercent(score: OmrGradeResult['score']): number | null {
  if (score.total == null || score.max == null || score.max <= 0) return null;
  return Math.round((score.total / score.max) * 100);
}

// Quy đổi điểm thang 10 (chuẩn phổ biến ở VN: điểm/điểm tối đa × 10), làm
// tròn 2 chữ số thập phân — hệ thống chưa có sẵn cột "điểm thang 10" nào
// khác để tái dùng (đã rà lại backend/frontend, không có công thức riêng),
// nên tính trực tiếp từ total/max giống hệt %  ở trên, chỉ khác đơn vị.
function scoreOn10(score: OmrGradeResult['score']): number | null {
  if (score.total == null || score.max == null || score.max <= 0) return null;
  return Math.round((score.total / score.max) * 10 * 100) / 100;
}

// Đường dẫn ảnh debug backend trả về (VD: "outputs/debug/xxx_overlay_all.jpg")
// cần quy về TƯƠNG ĐỐI (giống GRADE_URL/QUICK_CHECK_URL ở trên) — không prefix
// VITE_API_BASE tuyệt đối, để còn chạy đúng qua cloudflared trên điện thoại.
function resolveOverlayUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  const norm = path.replace(/\\/g, '/');
  const idx = Math.max(norm.lastIndexOf('outputs/'), norm.lastIndexOf('uploads/'));
  const relative = idx >= 0 ? norm.slice(idx) : norm.replace(/^\//, '');
  return `/${relative}`;
}

// ── Tải ảnh đã chấm (2026-10-06) ─────────────────────────────────────────────
// anh Tú: "thêm nút tải ảnh xuống để tải ảnh này về" + "gửi ảnh các bài": the
// graded picture (green/red marks, score in the corner) of one bài, or of
// every bài of the session as one .zip.

function overlayPathOf(r: OmrGradeResult): string | null {
  return resolveOverlayUrl(r.debug?.overlay_all_path ?? r.debug?.aligned_image_path);
}

/** "SBD 123456 - Ma de 101 - 8.5 diem.jpg" — whatever the sheet read. */
function gradedImageName(r: OmrGradeResult, index?: number): string {
  const parts: string[] = [];
  if (index != null) parts.push(String(index + 1).padStart(2, '0'));
  // only fully read numbers ("_" = a column left blank or unreadable)
  const ok = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !v.includes('_');
  const info = r.student_info ?? {};
  const sbd = [info.sbd, info.cccd].find(ok);
  const maDe = [info.ma_de, info.made].find(ok);
  if (sbd) parts.push(`SBD ${sbd}`);
  if (maDe) parts.push(`Ma de ${maDe}`);
  if (!sbd && !maDe) {
    // custom templates key their fields by block name (Mẫu 40: mã SV, mã đề)
    parts.push(...Object.values(info).filter(ok).slice(0, 2));
  }
  const d = scoreOn10(r.score);
  if (d != null) parts.push(`${d} diem`);
  if (parts.length === (index != null ? 1 : 0)) parts.push('bai cham');
  return `${parts.join(' - ').replace(/[\\/:*?"<>|]+/g, '_')}.jpg`;
}

async function fetchGradedImage(r: OmrGradeResult): Promise<Blob | null> {
  const url = overlayPathOf(r);
  if (!url) return null;
  try {
    const res = await fetch(url);
    return res.ok ? await res.blob() : null;
  } catch { return null; }
}

// ── Setup screen (chọn mẫu phiếu + kỳ thi, bấm Bắt đầu) ─────────────────────

/** One answer sheet the teacher can grade with: VJU SBD 4/8 số, the shared
 *  ones (Mẫu 40, Phiếu Bộ GD) and the teacher's own custom templates. */
interface SheetOption {
  key:      string;
  mode:     'vju' | 'custom';
  id:       number | null;
  variant?: TemplateVariant;
  name:     string;
  image:    string | null;
}

function sameSheet(o: SheetOption, tpl: LastUsedTemplate | null, variant: TemplateVariant): boolean {
  if (!tpl || tpl.mode === 'vju') return o.mode === 'vju' && o.variant === variant;
  return o.mode === 'custom' && o.id === tpl.id;
}

/** 2026-10-05: "sao cái chấm nhanh này giao diện nnay khó dùng. làm cho nó giao
 *  diện chọn mẫu phiếu giống cái kia" — pick the sheet right here, as cards
 *  with the sheet's picture like Upload & Chấm, instead of a detour through
 *  Answer Key. */
function SheetCards({ options, tpl, variant, onPick, disabled }: {
  options: SheetOption[]; tpl: LastUsedTemplate | null; variant: TemplateVariant;
  onPick: (o: SheetOption) => void; disabled?: boolean;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
      {options.map(o => {
        const on = sameSheet(o, tpl, variant);
        return (
          <button key={o.key} type="button" disabled={disabled} onClick={() => onPick(o)}
            style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6, padding: 6, textAlign: 'left',
              border: `2px solid ${on ? '#C8102E' : '#E5E7EB'}`, borderRadius: 12, background: on ? '#FEF2F2' : '#fff',
              cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', opacity: disabled && !on ? 0.5 : 1 }}>
            <div style={{ width: '100%', boxSizing: 'border-box', height: 110, borderRadius: 8, overflow: 'hidden', background: '#F3F4F6',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {o.image
                ? <img src={o.image} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
                : <LayoutTemplate size={30} color="#9CA3AF" />}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: on ? '#C8102E' : '#1F2937', lineHeight: 1.5, padding: '0 2px 1px',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {o.name}
            </div>
            {on && <CheckCircle2 size={18} color="#fff" fill="#C8102E" style={{ position: 'absolute', top: 10, right: 10 }} />}
          </button>
        );
      })}
    </div>
  );
}

function SetupScreen({
  store, tpl, variant, sheets, onPickSheet, onEditAnswers, onImportFiles, importNote, importing, onStart, exams, examId, onSelectExam, examInfo,
}: {
  store: AnswerKeyStore | null;
  tpl: LastUsedTemplate | null;
  variant: TemplateVariant;
  sheets: SheetOption[];
  onPickSheet: (o: SheetOption) => void;
  onEditAnswers: () => void;
  /** Answer file(s) picked on the phone → the chosen sheet's answer key. */
  onImportFiles: (files: File[]) => void;
  importNote: { ok: string; warnings: string[] } | null;
  importing: boolean;
  onStart: () => void;
  exams: ExamOut[];
  examId: number | null;
  onSelectExam: (id: number | null) => void;
  /** Set when the chosen kỳ thi has bộ đề trộn attached (null = none / loading). */
  examInfo: { loading: boolean; papers: string[]; versions: string[]; sheetName?: string } | null;
}) {
  const mode = tpl?.mode ?? 'vju';
  const hasAnswers = !!store && (
    Object.keys(store.answers ?? {}).length > 0 || isMultiMaDe(store)
  );
  const firstSet = store?.byMaDe ? Object.values(store.byMaDe)[0]?.answers : undefined;
  const questionCount = Object.keys(firstSet ?? store?.answers ?? {}).length;
  const maDeCount = store?.byMaDe ? Object.keys(store.byMaDe).length : 0;
  const templateLabel = mode === 'custom'
    ? (tpl?.name ?? 'Custom template')
    : TEMPLATE_VARIANT_LABEL[variant];
  const fromPapers = examId != null && !!examInfo && !examInfo.loading && examInfo.versions.length > 0;
  const fileRef = useRef<HTMLInputElement>(null);
  const importButton = (primary: boolean) => (
    <Button size="sm" variant={primary ? 'primary' : 'secondary'} icon={<FileUp size={14} />} loading={importing}
      onClick={() => fileRef.current?.click()}>
      Nhập file đáp án
    </Button>
  );

  return (
    <div style={{ padding: 24, maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: '#FEECEC', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Zap size={20} color="#C8102E" />
          </div>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#1E1E1E' }}>Chọn mẫu phiếu</div>
        </div>

        <SheetCards options={sheets} tpl={tpl} variant={variant} onPick={onPickSheet} />

        {/* 2026-09-29 (bước 6.3): pick a kỳ thi → if it has bộ đề trộn
           attached (Trộn đề page), the answer key of each mã đề is used
           automatically, exactly like the Upload → Answer Key flow. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: '#6B7280', fontWeight: 600 }}>Kỳ thi (lấy đáp án từ bộ đề trộn)</span>
          {/* width 100% + minWidth 0: a <select> otherwise sizes itself to its
              longest option and pushed the whole card off a phone screen */}
          <select value={examId ?? ''} onChange={e => onSelectExam(e.target.value ? Number(e.target.value) : null)}
            style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
              border: '1.5px solid #D1D5DB', fontSize: 14, fontFamily: 'inherit', background: '#fff' }}>
            <option value="">Không chọn, dùng đáp án đã lưu</option>
            {exams.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
          </select>
          {examId != null && examInfo?.loading && <span style={{ fontSize: 12, color: '#9CA3AF' }}>Đang tải đáp án…</span>}
          {examId != null && examInfo && !examInfo.loading && examInfo.versions.length === 0 && (
            <span style={{ fontSize: 12, color: '#B45309' }}>
              Kỳ thi này chưa có bộ đề trộn cho phiếu đang chọn, nên dùng đáp án đã lưu ở Answer Key.
            </span>
          )}
          {fromPapers && (
            <span style={{ fontSize: 12.5, color: '#15803D' }}>
              ✓ Đáp án tự động từ bộ đề <b>{examInfo!.papers.join(', ')}</b>: {examInfo!.versions.length} mã đề ({examInfo!.versions.join(', ')})
            </span>
          )}
        </div>

        {!hasAnswers ? (
          <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <AlertTriangle size={16} color="#C2410C" style={{ flexShrink: 0 }} />
            <div style={{ flex: '1 1 200px', fontSize: 13, color: '#9A3412', lineHeight: 1.5 }}>
              <strong>{templateLabel}</strong> chưa có đáp án. Chọn file đáp án Excel trong máy (nhiều mã đề thì chọn nhiều file cùng lúc), hoặc nhập tay.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {importButton(true)}
              <Button size="sm" variant="secondary" icon={<Settings2 size={14} />} onClick={onEditAnswers}>Nhập tay</Button>
            </div>
          </div>
        ) : (
          <div style={{ background: '#F9FAFB', border: '1px solid #EEF0F2', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px', fontSize: 13, color: '#374151' }}>
              <strong>{templateLabel}</strong> — {questionCount} câu đã có đáp án
              {maDeCount > 0 && <> · {maDeCount} mã đề</>}
            </div>
            {!fromPapers && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {importButton(false)}
                <Button size="sm" variant="secondary" icon={<Settings2 size={14} />} onClick={onEditAnswers}>Sửa đáp án</Button>
              </div>
            )}
          </div>
        )}
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) onImportFiles(f); }} />
        {importNote && (
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            {importNote.ok && <div style={{ color: '#15803D' }}>✓ {importNote.ok}</div>}
            {importNote.warnings.length > 0 && (
              <div style={{ color: '#B45309', marginTop: 4 }}>
                {importNote.warnings.slice(0, 4).map((w, i) => <div key={i}>⚠ {w}</div>)}
                {importNote.warnings.length > 4 && <div>… và {importNote.warnings.length - 4} cảnh báo khác</div>}
              </div>
            )}
          </div>
        )}
      </Card>

      <Button
        variant="primary"
        size="lg"
        icon={<CameraIcon size={18} />}
        disabled={!hasAnswers}
        onClick={onStart}
        style={{ width: '100%' }}
      >
        Bắt đầu chấm nhanh
      </Button>

      <div style={{ fontSize: 12, color: '#9CA3AF', textAlign: 'center', lineHeight: 1.6 }}>
        Giơ máy lên, camera tự nhận diện phiếu và chấm ngay — không cần bấm chụp hay xác nhận ảnh.
        Điểm hiện ra trong 1-2 giây, tráo phiếu tiếp theo là chấm luôn.
      </div>
    </div>
  );
}

/** A kỳ thi's bộ đề trộn as an answer key: one set per mã đề. */
function paperStore(k: { versions: string[]; byMaDe: Record<string, Record<string, string>> }): AnswerKeyStore {
  const scoring   = loadAnswerKey()?.scoring ?? { ...DEFAULT_SCORING };
  const updatedAt = new Date().toISOString();
  return {
    answers: {},
    scoring,
    updatedAt,
    byMaDe: Object.fromEntries(k.versions.map(code => [code, { answers: k.byMaDe[code], scoring, updatedAt }])),
  };
}

// ── Trang chính ─────────────────────────────────────────────────────────────

export default function QuickGradePage() {
  const navigate = useNavigate();

  const [store, setStore] = useState<AnswerKeyStore | null>(null);
  const [tpl,   setTpl]   = useState<LastUsedTemplate | null>(null);
  const [variant, setVariant] = useState<TemplateVariant>('sbd8');
  const [sessionActive, setSessionActive] = useState(false);
  const [exams, setExams] = useState<ExamOut[]>([]);
  const [examId, setExamId] = useState<number | null>(null);
  const [examInfo, setExamInfo] = useState<{ loading: boolean; papers: string[]; versions: string[]; sheetName?: string } | null>(null);

  const [customSheets, setCustomSheets] = useState<SheetOption[]>([]);

  useEffect(() => {
    const last = loadLastUsedTemplate();
    setStore(last ? savedKeyFor(last) : loadAnswerKey());
    setTpl(last);
    examsApi.list().then(setExams).catch(() => setExams([]));
    customFormsApi.list()
      .then(({ forms }) => setCustomSheets(forms
        .filter(f => !PINNED_TEMPLATES.some(pt => pt.id === f.id))
        .map(f => ({ key: `custom:${f.id}`, mode: 'custom' as const, id: f.id, name: f.name, image: null }))))
      .catch(() => setCustomSheets([]));
  }, []);

  const sheets: SheetOption[] = useMemo(() => [
    { key: 'vju:sbd4', mode: 'vju', id: null, variant: 'sbd4', name: TEMPLATE_VARIANT_LABEL.sbd4, image: VJU_SBD4_PREVIEW_IMAGE },
    { key: 'vju:sbd8', mode: 'vju', id: null, variant: 'sbd8', name: TEMPLATE_VARIANT_LABEL.sbd8, image: VJU_SBD8_PREVIEW_IMAGE },
    ...PINNED_TEMPLATES.map(pt => ({ key: `custom:${pt.id}`, mode: 'custom' as const, id: pt.id, name: pt.label, image: pt.previewImage ?? null })),
    ...customSheets,
  ], [customSheets]);

  // Whose the active answer key is when an older save didn't record it: the
  // sheet last used when this page opened (picking cards here changes the
  // "last used" sheet, but not whose answers the active key holds).
  const legacyOwner = useRef<string | null>(null);
  if (legacyOwner.current === null) {
    const last = loadLastUsedTemplate();
    legacyOwner.current = last ? templateStoreKeyFor(last.mode, last.id) : 'vju';
  }

  /** The answers saved for a sheet: the active key when it was saved for
   *  that sheet, else that sheet's own Answer Key slot. */
  const savedKeyFor = (t: LastUsedTemplate): AnswerKeyStore | null => {
    const key = templateStoreKeyFor(t.mode, t.id);
    const owner = loadAnswerKeyOwner() ?? legacyOwner.current;
    if (owner === key) return loadAnswerKey() ?? loadAnswerKeyDraft(key);
    return loadAnswerKeyDraft(key);
  };

  // Re-đọc mỗi khi quay lại trang (ví dụ sau khi qua Answer Key sửa rồi bấm Back)
  // — only when no kỳ thi is driving the answer key.
  const tplRef = useRef(tpl);
  tplRef.current = tpl;
  useEffect(() => {
    if (examId != null) return;
    const onFocus = () => { if (tplRef.current) setStore(savedKeyFor(tplRef.current)); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [examId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A sheet card picked: its own answers — the kỳ thi's bộ đề mixed for
   *  that sheet when a kỳ thi is chosen, else the ones saved for it. */
  const pickSheet = (o: SheetOption) => {
    const t: LastUsedTemplate = { mode: o.mode, id: o.id, name: o.mode === 'custom' ? o.name : null };
    setTpl(t);
    setImportNote(null);
    if (o.variant) setVariant(o.variant);
    if (examId == null || o.mode !== 'custom' || o.id == null) {
      setStore(savedKeyFor(t));
      if (examId != null) setExamInfo({ loading: false, papers: [], versions: [] });
      return;
    }
    setExamInfo({ loading: true, papers: [], versions: [] });
    examPapersApi.examAnswerKey(examId, o.id)
      .then(k => {
        setExamInfo({ loading: false, papers: k.papers, versions: k.versions });
        setStore(k.versions.length ? paperStore(k) : savedKeyFor(t));
      })
      .catch(() => { setExamInfo({ loading: false, papers: [], versions: [] }); setStore(savedKeyFor(t)); });
  };

  // 2026-10-05: "thao tác trên điện thoại thì làm sao t import được file đáp
  // án vào để chấm ? … gv dùng trên đth là chính" — pick the answer file(s)
  // right here. Same rules as Answer Key's Import Excel: the mã đề comes
  // from the file name ("Dap_an_Ma_de_101.xlsx") or the file's "Đề 101"
  // sheets; a new mã đề is added, an existing one replaced. The result is
  // saved as this sheet's answer key, so Answer Key / Upload see it too.
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<{ ok: string; warnings: string[] } | null>(null);

  const schemaFor = async (t: LastUsedTemplate | null): Promise<TemplateSchema | null> => {
    if (!t || t.mode === 'vju' || t.id == null) return VJU_PRESET_SCHEMA;
    try { return buildSchemaFromDetail(await customFormsApi.get(t.id)); } catch { return null; }
  };

  const importFiles = async (files: File[]) => {
    const t: LastUsedTemplate = tpl ?? { mode: 'vju', id: null, name: null };
    setImportNote(null);
    setImporting(true);
    try {
      const schema = await schemaFor(t);
      if (!schema) { setImportNote({ ok: '', warnings: ['Không tải được mẫu phiếu, thử lại sau.'] }); return; }
      const base = savedKeyFor(t);
      let next: AnswerKeyStore = base
        ? { ...base, byMaDe: base.byMaDe ? { ...base.byMaDe } : undefined }
        : { answers: {}, scoring: { ...DEFAULT_SCORING }, updatedAt: '' };
      const warnings: string[] = [];
      const done: string[] = [];
      const replaced: string[] = [];
      for (const file of files) {
        let parsed;
        try { parsed = await parseAnswerKeyWorkbook(file, schema); }
        catch { warnings.push(`${file.name}: không đọc được file (.xlsx)`); continue; }
        warnings.push(...parsed.warnings.map(w => (files.length > 1 ? `${file.name}: ${w}` : w)));
        next.scoring = parsed.store.scoring;
        const sets = parsed.store.byMaDe && Object.keys(parsed.store.byMaDe).length > 0
          ? Object.entries(parsed.store.byMaDe).map(([code, set]) => ({ code, answers: set.answers }))
          : null;
        let code: string | null = null;
        if (!sets) {
          code = maDeFromFileName(file.name);
          if (!code && (files.length > 1 || next.byMaDe)) {
            code = (window.prompt(`File "${file.name}" là đáp án của mã đề nào? (VD: 101)`, '') ?? '').trim() || null;
            if (!code) { warnings.push(`${file.name}: chưa nhập mã đề nên bỏ qua file này`); continue; }
          }
        }
        for (const x of sets ?? (code ? [{ code, answers: parsed.store.answers }] : [])) {
          const now = new Date().toISOString();
          if (Object.values(next.byMaDe?.[x.code]?.answers ?? {}).some(v => v)) replaced.push(x.code);
          next.byMaDe = { ...(next.byMaDe ?? {}), [x.code]: { answers: x.answers, scoring: next.scoring, updatedAt: now } };
          done.push(`Đề ${x.code}`);
        }
        if (!sets && !code) {             // one đề, no mã đề: the plain answer key
          next = { ...next, answers: parsed.store.answers };
          done.push(file.name);
        }
      }
      if (done.length === 0) { setImportNote({ ok: '', warnings: warnings.length ? warnings : ['Không có đáp án nào trong file'] }); return; }
      next.updatedAt = new Date().toISOString();
      saveLastUsedTemplate(t);
      saveAnswerKey(next, templateStoreKeyFor(t.mode, t.id));
      saveAnswerKeyDraft(templateStoreKeyFor(t.mode, t.id), next);
      setStore(next);
      setImportNote({
        ok: `Đã nạp ${done.join(', ')}` + (replaced.length ? ` (đề ${replaced.join(', ')} thay bằng file mới)` : ''),
        warnings,
      });
    } finally {
      setImporting(false);
    }
  };

  /** Answer Key opens on the chosen sheet (it starts on the last used one). */
  const editAnswers = () => {
    if (tpl) saveLastUsedTemplate(tpl);
    navigate('/app/answer-key');
  };

  // Kỳ thi chosen → use its bộ đề trộn answer keys (one set per mã đề, on the
  // "Mẫu 40 câu" sheet). No bộ đề attached → fall back to the saved key.
  const selectExam = (id: number | null) => {
    setExamId(id);
    if (id == null) {
      setExamInfo(null);
      if (tpl) setStore(savedKeyFor(tpl));
      return;
    }
    setExamInfo({ loading: true, papers: [], versions: [] });
    examPapersApi.examAnswerKey(id)
      .then(k => {
        setExamInfo({ loading: false, papers: k.papers, versions: k.versions, sheetName: sheetTemplate(k.sheets, k.sheetNames).name });
        if (k.versions.length === 0) {
          if (tpl) setStore(savedKeyFor(tpl));
          return;
        }
        setStore(paperStore(k));
        // the sheet the bộ đề were mixed for
        const t = sheetTemplate(k.sheets, k.sheetNames);
        setTpl({ mode: t.mode, id: t.id, name: t.name });
      })
      .catch(() => setExamInfo({ loading: false, papers: [], versions: [] }));
  };

  if (!sessionActive) {
    return (
      <>
        <PageHeader
          title="Chấm nhanh liên tục"
          subtitle="Giơ máy lên là tự động chấm — hiện điểm ngay, không cần thao tác thêm."
          actions={<Button variant="secondary" icon={<ArrowLeft size={15} />} onClick={() => navigate('/app/upload')}>Về Upload &amp; Chấm</Button>}
        />
        <SetupScreen
          store={store}
          tpl={tpl}
          variant={variant}
          sheets={sheets}
          onPickSheet={pickSheet}
          onEditAnswers={editAnswers}
          onImportFiles={files => { void importFiles(files); }}
          importNote={importNote}
          importing={importing}
          onStart={() => setSessionActive(true)}
          exams={exams}
          examId={examId}
          onSelectExam={selectExam}
          examInfo={examInfo}
        />
      </>
    );
  }

  return (
    <QuickGradeCamera
      store={store as AnswerKeyStore}
      tpl={tpl}
      variant={variant}
      onExit={(results) => {
        setSessionActive(false);
        if (results.length === 0) return;
        const mode = tpl?.mode ?? 'vju';
        const batch: BatchGradeState = {
          templateVariant: variant,
          results,
          gradedAt: new Date().toISOString(),
          templateMode: mode,
          customTemplateId:   mode === 'custom' ? (tpl?.id ?? null) : null,
          customTemplateName: mode === 'custom' ? (tpl?.name ?? null) : null,
          templateSchema: null,
        };
        navigate('/app/results', { state: batch });
      }}
    />
  );
}

// ── Camera chấm liên tục ─────────────────────────────────────────────────────

function QuickGradeCamera({
  store, tpl, variant, onExit,
}: {
  store: AnswerKeyStore;
  tpl: LastUsedTemplate | null;
  variant: TemplateVariant;
  onExit: (results: OmrGradeResult[]) => void;
}) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [error,    setError]    = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [autoState, setAutoState] = useState<AutoState>('searching');
  const [readyStreak, setReadyStreak] = useState(0);
  const [grading,  setGrading]  = useState(false);
  const [lastResult, setLastResult] = useState<OmrGradeResult | null>(null);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [results,  setResults]  = useState<OmrGradeResult[]>([]);

  const checkingRef     = useRef(false);
  const waitingClearRef = useRef(false);
  /** The sheet just auto-graded (corners + fingerprint), to tell the next one from it. */
  const gradedRef       = useRef<SheetMark | null>(null);
  /** Corners at the previous check, to know the sheet is held still. */
  const lastSeenRef     = useRef<number[][] | null>(null);
  const readyStreakRef  = useRef(0);
  const gradingRef      = useRef(false);
  const bannerTimerRef  = useRef<number | null>(null);
  const resultsRef      = useRef<OmrGradeResult[]>([]);
  resultsRef.current = results;

  const isCustom = tpl?.mode === 'custom';
  // useMemo — không phải chỉ để tối ưu: buildAnswerKeyPayload() trả về 1
  // object literal mới mỗi lần gọi. Nếu không memo theo `store` (props ổn
  // định, chỉ set 1 lần từ QuickGradePage), captureAndGrade bên dưới (deps
  // có answerKeyPayload) sẽ đổi identity ở MỌI lần render — mà QuickGradeCamera
  // re-render liên tục theo từng tick poll (readyStreak/autoState đổi mỗi
  // 450ms) — khiến effect vòng lặp nhận diện bị huỷ + tạo lại interval liên
  // tục thay vì chạy ổn định 1 lần.
  const answerKeyPayload = useMemo(() => buildAnswerKeyPayload(store), [store]);

  // Trọng số điểm ở "Thang điểm" (Đúng/Sai/Bỏ trống + điểm riêng từng câu) —
  // dùng CHUNG 1 bộ (store.scoring cấp cao nhất, không phải riêng theo từng
  // mã đề) vì điểm số là thuộc tính của ĐỀ THI, không đổi theo mã đề — chỉ
  // có đáp án đúng mới đổi theo mã đề. Gửi kèm để backend tính điểm từng câu
  // (kể cả câu đã đặt điểm riêng) và in tóm tắt điểm từng Phần lên ảnh kết quả.
  const scoringPayload = useMemo(() => store.scoring, [store]);

  // ── Mở camera ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      setStarting(true);
      setError(null);
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Trình duyệt không hỗ trợ camera ở đây, hoặc trang web chưa chạy trên HTTPS (bắt buộc để dùng camera).');
        setStarting(false);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError') {
          setError('Bạn chưa cho phép dùng camera. Vào cài đặt trình duyệt cấp lại quyền Camera cho trang này rồi thử lại.');
        } else if (name === 'NotFoundError') {
          setError('Không tìm thấy camera trên thiết bị này.');
        } else {
          setError(`Không mở được camera: ${(err as Error)?.message ?? 'lỗi không rõ'}`);
        }
      } finally {
        if (!cancelled) setStarting(false);
      }
    };
    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      if (bannerTimerRef.current) window.clearTimeout(bannerTimerRef.current);
    };
  }, []);

  const handleExit = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    onExit(resultsRef.current);
  };

  // Tải ảnh: one bài (keeps its result on screen while saving), or all of them
  const [saving, setSaving] = useState<'one' | 'zip' | null>(null);
  const downloadOne = async (r: OmrGradeResult) => {
    if (bannerTimerRef.current) window.clearTimeout(bannerTimerRef.current);
    setSaving('one');
    const blob = await fetchGradedImage(r);
    setSaving(null);
    if (blob) saveAs(blob, gradedImageName(r));
    else alert('Không tải được ảnh của bài này.');
    bannerTimerRef.current = window.setTimeout(() => { setLastResult(null); setGradeError(null); }, RESULT_BANNER_MS);
  };
  const downloadAll = async () => {
    const list = resultsRef.current;
    if (list.length === 0) return;
    setSaving('zip');
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        const blob = await fetchGradedImage(list[i]);
        if (blob) { zip.file(gradedImageName(list[i], i), blob); n++; }
      }
      if (n === 0) { alert('Không tải được ảnh nào.'); return; }
      const ts = new Date();
      const pad = (x: number) => String(x).padStart(2, '0');
      saveAs(await zip.generateAsync({ type: 'blob' }),
        `Anh bai cham ${pad(ts.getDate())}-${pad(ts.getMonth() + 1)} ${pad(ts.getHours())}h${pad(ts.getMinutes())}.zip`);
      if (n < list.length) alert(`Đã tải ${n}/${list.length} ảnh, ${list.length - n} bài không có ảnh.`);
    } finally {
      setSaving(null);
    }
  };

  const showResultBanner = useCallback((r: OmrGradeResult | null, err: string | null) => {
    setLastResult(r);
    setGradeError(err);
    if (bannerTimerRef.current) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => {
      setLastResult(null);
      setGradeError(null);
    }, RESULT_BANNER_MS);
  }, []);

  // Chụp full-res khung hình hiện tại rồi gửi CHẤM NGAY — không dừng lại ở
  // bước xem trước/xác nhận (bỏ hẳn theo lựa chọn ưu tiên tốc độ).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const captureAndGrade = useCallback((auto = false) => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || gradingRef.current) return;

    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async blob => {
      if (!blob) return;
      gradingRef.current = true;
      setGrading(true);
      try {
        const form = new FormData();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        form.append('image', blob, `camera_${ts}.jpg`);

        const templateParam = isCustom && tpl?.id != null
          ? `&template_id=${tpl.id}`
          : `&template_variant=${variant}`;
        const answerKeyParam = answerKeyPayload
          ? `&answer_key_json=${encodeURIComponent(JSON.stringify(answerKeyPayload))}`
          : '';
        const scoringParam = scoringPayload
          ? `&scoring_json=${encodeURIComponent(JSON.stringify(scoringPayload))}`
          : '';
        // full_debug=true — cần debug.overlay_all_path để hiện ảnh detect to
        // ngay trên màn hình Chấm nhanh (thay cho banner điểm nhỏ trước đây).
        const url = `${GRADE_URL}?mean_mode=circle_mask&full_debug=true&image_source=auto${templateParam}${answerKeyParam}${scoringParam}`;

        const res = await fetch(url, { method: 'POST', body: form });
        if (!res.ok) {
          const txt = await res.text();
          showResultBanner(null, `Lỗi chấm: HTTP ${res.status} — ${txt.slice(0, 160)}`);
        } else {
          const data = await res.json() as OmrGradeResult;
          const prev = resultsRef.current[resultsRef.current.length - 1];
          if (auto && prev && sameReading(prev, data)) {
            // the sheet just graded, seen again: not counted twice
            setNotice('Phiếu này vừa chấm rồi, đưa phiếu tiếp theo');
            if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
            noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2500);
          } else {
            setResults(rs => [...rs, data]);
            showResultBanner(data, null);
          }
        }
      } catch (err) {
        showResultBanner(null, `Không gửi được ảnh lên chấm: ${(err as Error)?.message ?? 'lỗi mạng'}`);
      } finally {
        gradingRef.current = false;
        setGrading(false);
      }
    }, 'image/jpeg', 0.92);
  }, [isCustom, tpl?.id, variant, answerKeyPayload, scoringPayload, showResultBanner]);

  // Vòng lặp nhận diện — giữ nguyên cơ chế của CameraCaptureModal (giữ yên
  // READY_STREAK_NEEDED lần liên tiếp mới trigger), chỉ khác ở chỗ trigger
  // ra là chấm ngay thay vì dừng lại chờ xác nhận.
  useEffect(() => {
    if (error || starting) return;

    const timer = window.setInterval(async () => {
      if (checkingRef.current || gradingRef.current) return;
      const video = videoRef.current;
      if (!video || video.videoWidth === 0) return;

      checkingRef.current = true;
      try {
        const scale = QUICK_CHECK_WIDTH / video.videoWidth;
        const w = QUICK_CHECK_WIDTH;
        const h = Math.max(1, Math.round(video.videoHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);

        const blob: Blob | null = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.7));
        if (!blob) return;

        const form = new FormData();
        form.append('image', blob, 'quick.jpg');
        const res = await fetch(QUICK_CHECK_URL, { method: 'POST', body: form });
        if (!res.ok) return;
        const data = (await res.json()) as QuickCheck;

        if (!data.detected) {
          waitingClearRef.current = false;
          readyStreakRef.current = 0;
          setReadyStreak(0);
          setAutoState('searching');
          lastSeenRef.current = null;
          return;
        }

        if (waitingClearRef.current) {
          // a sheet is in view: still the one just graded, or the next one
          // pushed on top (moved corners / another fingerprint)?
          const graded = gradedRef.current;
          const fp = decodeFingerprint(data.fingerprint);
          const moved = cornerShift(data.corners, graded?.corners) > NEW_SHEET_MOVE;
          const other = !!(fp && graded?.fp && fingerprintDistance(fp, graded.fp) > NEW_SHEET_FP_DIST);
          if (!graded || !(moved || other)) {
            setAutoState('clearing');
            lastSeenRef.current = data.corners ?? null;
            return;
          }
          waitingClearRef.current = false;
          readyStreakRef.current = 0;
        }

        // held still: the corners barely moved since the last check
        const still = cornerShift(data.corners, lastSeenRef.current ?? undefined) <= HOLD_STILL_MOVE;
        lastSeenRef.current = data.corners ?? null;
        if (data.ready && (still || readyStreakRef.current === 0)) {
          readyStreakRef.current += 1;
          setReadyStreak(readyStreakRef.current);
          setAutoState('holding');
          if (readyStreakRef.current >= READY_STREAK_NEEDED) {
            readyStreakRef.current = 0;
            setReadyStreak(0);
            waitingClearRef.current = true;
            gradedRef.current = { corners: data.corners ?? [], fp: decodeFingerprint(data.fingerprint) };
            captureAndGrade(true);
          }
        } else if (data.ready) {
          // moving: start counting again from this frame
          readyStreakRef.current = 1;
          setReadyStreak(1);
          setAutoState('holding');
        } else {
          readyStreakRef.current = 0;
          setReadyStreak(0);
          setAutoState('holding');
        }
      } catch {
        // Bỏ qua lỗi mạng ở 1 lần kiểm tra — thử lại ở lần tiếp theo.
      } finally {
        checkingRef.current = false;
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [error, starting, captureAndGrade]);

  const ringColor =
    autoState === 'clearing' ? '#3B82F6'
    : autoState === 'holding'  ? '#F59E0B'
    : '#9CA3AF';

  const statusText = grading
    ? 'Đang chấm…'
    : notice ? notice
    : autoState === 'clearing' ? 'Đã chấm ✓ — đưa phiếu tiếp theo vào'
    : autoState === 'holding'  ? `Giữ yên… (${readyStreak}/${READY_STREAK_NEEDED})`
    : 'Đưa phiếu vào khung, thấy rõ cả 4 góc';

  const avgPercent = (() => {
    const pcts = results.map(r => scorePercent(r.score)).filter((p): p is number => p != null);
    if (pcts.length === 0) return null;
    return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  })();

  // Ảnh detect to hiện ngay sau khi chấm — ưu tiên overlay chấm màu xanh/đỏ
  // (debug.overlay_all_path), nếu backend không trả (VD lỗi trước khi tới
  // bước overlay) thì rơi về ảnh đã căn chỉnh/cân bằng sáng.
  const overlayImgSrc = lastResult
    ? resolveOverlayUrl(lastResult.debug?.overlay_all_path ?? lastResult.debug?.aligned_image_path)
    : null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#000', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px', background: 'rgba(0,0,0,0.55)', color: '#fff',
        position: 'relative', zIndex: 3, flexWrap: 'wrap', gap: 10,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={16} />
          Chấm nhanh
          {results.length > 0 && (
            <span style={{ background: '#C8102E', borderRadius: 9999, padding: '2px 10px', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
              <ListChecks size={12} /> {results.length} phiếu{avgPercent != null && ` · TB ${avgPercent}%`}
            </span>
          )}
        </div>
        <button
          onClick={handleExit}
          style={{ border: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 9999, width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', cursor: 'pointer', flexShrink: 0 }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Video */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {error ? (
          <div style={{ maxWidth: 420, textAlign: 'center', color: '#fff', padding: 24 }}>
            <div style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 18 }}>{error}</div>
            <Button variant="secondary" onClick={handleExit}>Đóng</Button>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%', height: '100%', objectFit: 'contain', background: '#000',
                boxShadow: `inset 0 0 0 4px ${ringColor}`,
                transition: 'box-shadow 160ms',
              }}
            />
            {!starting && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <div style={{
                  width: 'min(72vw, 51vh)',
                  aspectRatio: '1 / 1.4142',
                  position: 'relative',
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                  borderRadius: 6,
                }}>
                  {([
                    { top: -2, left: -2, borderWidth: '4px 0 0 4px', borderTopLeftRadius: 6 },
                    { top: -2, right: -2, borderWidth: '4px 4px 0 0', borderTopRightRadius: 6 },
                    { bottom: -2, left: -2, borderWidth: '0 0 4px 4px', borderBottomLeftRadius: 6 },
                    { bottom: -2, right: -2, borderWidth: '0 4px 4px 0', borderBottomRightRadius: 6 },
                  ] as const).map((s, i) => (
                    <div
                      key={i}
                      style={{
                        position: 'absolute', width: 26, height: 26,
                        borderColor: 'rgba(255,255,255,0.85)', borderStyle: 'solid',
                        ...s,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
            {starting && (
              <div style={{ position: 'absolute', color: '#fff', fontSize: 13, opacity: 0.8 }}>
                Đang mở camera…
              </div>
            )}
            {!starting && (
              <div style={{
                position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 13, fontWeight: 600,
                padding: '7px 16px', borderRadius: 9999, whiteSpace: 'nowrap',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                {grading && <span style={{ width: 12, height: 12, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />}
                {statusText}
              </div>
            )}

            {/* Kết quả chấm — ảnh detect to (đè lên khung camera, không chặn
                thao tác vì tự ẩn + tự chuyển tiếp sau vài giây, không cần bấm
                tiếp tục), thay hẳn banner nhỏ trước đây theo lựa chọn của
                người dùng. */}
            {(lastResult || gradeError) && (
              <div style={{
                position: 'absolute', inset: 10, zIndex: 5,
                background: gradeError ? 'rgba(153,27,27,0.95)' : 'rgba(10,10,12,0.96)',
                borderRadius: 16, padding: 14, color: '#fff',
                display: 'flex', flexDirection: 'column', gap: 10,
                boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
              }}>
                {gradeError ? (
                  <div style={{ margin: 'auto', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', fontSize: 14, lineHeight: 1.6, maxWidth: 420, textAlign: 'center' }}>
                    <AlertTriangle size={28} color="#FBBF24" />
                    <span>{gradeError}</span>
                  </div>
                ) : lastResult && (
                  <>
                    {/* Thanh điểm tóm tắt */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
                      {lastResult.score.total != null && lastResult.score.max != null ? (
                        <div style={{ textAlign: 'center', flexShrink: 0 }}>
                          {/* Điểm thang 10 — số điểm thật (tính điểm), màu đỏ
                              kiểu chấm bằng bút đỏ như trên phiếu giấy */}
                          <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: '#EF4444' }}>
                            {scoreOn10(lastResult.score)}
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                            {lastResult.score.total}/{lastResult.score.max} · {scorePercent(lastResult.score)}%
                          </div>
                        </div>
                      ) : (
                        <AlertTriangle size={22} color="#FBBF24" style={{ flexShrink: 0 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5 }}>
                        {lastResult.score.total != null ? (
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', opacity: 0.9 }}>
                            <span>Đúng {lastResult.score.correct}</span>
                            <span>Sai {lastResult.score.wrong}</span>
                            <span>Bỏ trống {lastResult.score.blank}</span>
                          </div>
                        ) : (
                          <div style={{ opacity: 0.9 }}>Không xác định được điểm — kiểm tra mã đề/đáp án đã khớp chưa.</div>
                        )}
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', opacity: 0.75, marginTop: 2 }}>
                          {lastResult.student_info?.sbd   && <span>SBD {lastResult.student_info.sbd}</span>}
                          {lastResult.student_info?.ma_de && <span>Mã đề {lastResult.student_info.ma_de}</span>}
                          {(lastResult.warnings?.length ?? 0) > 0 && (
                            <span style={{ color: '#FBBF24' }}>⚠ {lastResult.warnings!.length} câu cần xem lại</span>
                          )}
                        </div>
                      </div>
                      {overlayImgSrc ? (
                        <button type="button" onClick={() => { void downloadOne(lastResult); }} disabled={saving === 'one'}
                          title="Tải ảnh bài này"
                          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 9999,
                            padding: '8px 12px', background: '#fff', color: '#111', fontSize: 12.5, fontWeight: 700,
                            fontFamily: 'inherit', cursor: 'pointer', opacity: saving === 'one' ? 0.6 : 1 }}>
                          <Download size={15} /> {saving === 'one' ? 'Đang tải…' : 'Tải ảnh'}
                        </button>
                      ) : (
                        <CheckCircle2 size={20} color="#34D399" style={{ flexShrink: 0 }} />
                      )}
                    </div>

                    {/* Ảnh detect to — overlay chấm màu xanh/đỏ trên phiếu đã căn chỉnh */}
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, overflow: 'hidden', background: '#000' }}>
                      {overlayImgSrc ? (
                        <img src={overlayImgSrc} alt="Kết quả nhận diện" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                      ) : (
                        <div style={{ fontSize: 12.5, opacity: 0.7, padding: 20, textAlign: 'center' }}>Không có ảnh chi tiết cho lần chấm này.</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom controls */}
      {!error && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28,
          padding: '20px 18px calc(20px + env(safe-area-inset-bottom))',
          background: 'rgba(0,0,0,0.55)', position: 'relative', zIndex: 2,
        }}>
          <button
            onClick={() => captureAndGrade(false)}
            disabled={starting || grading}
            aria-label="Chụp và chấm ngay"
            title="Chụp và chấm ngay (dự phòng nếu chế độ tự động không bắt được)"
            style={{
              width: 68, height: 68, borderRadius: '50%',
              background: '#fff', border: '4px solid rgba(255,255,255,0.35)',
              cursor: (starting || grading) ? 'not-allowed' : 'pointer', opacity: (starting || grading) ? 0.5 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span style={{ width: 54, height: 54, borderRadius: '50%', background: '#C8102E' }} />
          </button>
          {results.length > 0 && (
            <Button
              variant="secondary"
              icon={<Download size={15} />}
              loading={saving === 'zip'}
              onClick={() => { void downloadAll(); }}
              style={{ position: 'absolute', left: 18 }}
              title="Tải ảnh đã chấm của tất cả các bài (.zip)"
            >
              Ảnh (.zip)
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<CheckCircle2 size={15} />}
            onClick={handleExit}
            style={{ position: 'absolute', right: 18 }}
          >
            Xong ({results.length})
          </Button>
        </div>
      )}

      {!error && !starting && (
        <div style={{ position: 'absolute', bottom: 96, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.75)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, pointerEvents: 'none' }}>
          <Hand size={12} /> Nút tròn = chấm thủ công dự phòng · để yên là tự động chấm liên tục
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
