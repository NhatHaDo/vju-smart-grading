import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { saveAs } from 'file-saver';
import { normalizeUploadFile } from '../utils/fileConversion';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import TemplatePreviewThumb, { type TemplateAreaLike } from '../components/common/TemplatePreviewThumb';
import PageHeader from '../components/layout/PageHeader';
import { Upload, Trash2, FileSpreadsheet, Save, CheckCircle2, Loader2, ArrowLeft, Zap, AlertTriangle, Layers, Plus, X, Copy, Library, BookmarkPlus, Pencil } from 'lucide-react';
import {
  VJU_PRESET_SCHEMA,
  type AnswerKeyStore,
  type AnswerKeySet,
  type ScoringWeights,
  type ProctorInfo,
  PROCTOR_FIELD_LABELS,
  type TemplateVariant,
  type ImageSource,
  type BatchGradeState,
  type OmrGradeResult,
  type TemplateSchema,
  type SavedAnswerKeyEntry,
  TEMPLATE_VARIANT_LABEL,
  DEFAULT_SCORING,
  loadAnswerKey,
  saveAnswerKey,
  clearAnswerKey,
  schemaHasMaDe,
  isMultiMaDe,
  loadLastUsedTemplate,
  type TemplateStoreKey,
  templateStoreKeyFor,
  loadExamAnswerKey,
  saveExamAnswerKey,
  loadAnswerKeyDraft,
  saveAnswerKeyDraft,
  clearAnswerKeyDraft,
  PINNED_TEMPLATES,
  VJU_SBD4_PREVIEW_IMAGE,
  VJU_SBD8_PREVIEW_IMAGE,
  loadAnswerKeyLibrary,
  addToAnswerKeyLibrary,
  upsertAutoLibraryEntry,
  removeFromAnswerKeyLibrary,
  updateAnswerKeyLibraryEntry,
  renameAnswerKeyLibraryEntry,
} from '../types/grading';
import { customFormsApi, examPapersApi } from '../services/apiClient';
import type { CustomFormMeta } from '../services/apiClient';
import { buildSchemaFromDetail, buildSchemaFromAnswerKeys } from '../utils/templateSchema';
import { buildAnswerKeyWorkbook, buildAnswerKeySampleWorkbook, parseAnswerKeyWorkbook } from '../utils/answerKeyExcel';

const CHOICES = ['—', 'A', 'B', 'C', 'D'];
// 2026-07-29: this used to be hardcoded to 'http://localhost:8000/...' —
// worked fine in local dev (backend on a separate port from the Vite dev
// server) but silently broke grading in production, where the frontend is
// served from the same origin as the API via an Apache reverse proxy
// (ProxyPass /api/ -> 127.0.0.1:8000). The browser would try to reach the
// user's own machine on port 8000 and fail with "TypeError: Failed to
// fetch" before the request ever left the browser (nothing shows up in the
// backend's uvicorn log). Mirrors the same VITE_API_BASE convention already
// used by services/apiClient.ts, so this now honors each environment's own
// .env file instead of always pointing at localhost.
const API_BASE = `${import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'}/api/v1/omr/debug-grade`;
const BATCH_LS_KEY = 'vju_last_batch_grade';

/**
 * Reads the sessionStorage schema cache written by TemplatePage/SheetReviewPage.
 * The cache is scoped to a specific template id ({id, schema}) — only used as
 * a fallback here if it matches `expectedId`, otherwise a stale schema from a
 * different, previously-viewed template could silently be reused (e.g. a
 * brand-new template appearing to only have the old one's question count).
 */
function loadTemplateSchemaFromStorage(expectedId: number | null): TemplateSchema | null {
  try {
    const raw = sessionStorage.getItem('vju_template_schema');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id: number; schema: TemplateSchema };
    if (!parsed || parsed.id !== expectedId) return null;
    return parsed.schema ?? null;
  } catch { return null; }
}

/**
 * Splits a trailing "(...)" range off a section title — e.g.
 * "Trắc nghiệm ABCD ( 1-10 )" → ["Trắc nghiệm ABCD", "( 1-10 )"] — so it can
 * be rendered as one non-breaking chunk. In a narrow card, the browser used
 * to wrap these titles wherever a space happened to fall, including right
 * inside the parentheses ("...ABCD ( 1-\n10 )"), which reads like a typo.
 * Rendering the "(...)" part with `white-space: nowrap` means it still wraps
 * to the next line as a whole when it doesn't fit, but never splits midway
 * (2026-07-30).
 */
function splitTrailingParen(title: string): [string, string | null] {
  const m = title.match(/^(.*?)(\s*\([^()]*\)\s*)$/);
  return m ? [m[1], m[2].trim()] : [title, null];
}

function SectionTitleText({ title }: { title: string }) {
  const [base, paren] = splitTrailingParen(title);
  if (!paren) return <>{title}</>;
  return <>{base} <span style={{ whiteSpace: 'nowrap' }}>{paren}</span></>;
}

interface GradingModeState {
  mode: 'before-grading';
  files: File[];
  templateVariant: TemplateVariant;
  imageSource?: ImageSource;
  examId?:   number | null;
  examName?: string | null;
  templateMode?:       'vju' | 'custom';
  customTemplateId?:   number | null;
  customTemplateName?: string | null;
  /** Full schema passed from SheetReviewPage — avoids sessionStorage dependency */
  templateSchema?:     TemplateSchema | null;
}

export default function AnswerKeyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const navState = location.state as GradingModeState | null;
  const isGradingMode = navState?.mode === 'before-grading';
  const gradingFiles: File[] = isGradingMode ? (navState.files ?? []) : [];
  const templateVariant: TemplateVariant = isGradingMode ? navState.templateVariant : 'sbd8';
  const imageSource: ImageSource = isGradingMode ? (navState.imageSource ?? 'auto') : 'auto';
  const examId:             number | null = isGradingMode ? (navState.examId             ?? null) : null;
  const examName:           string | null = isGradingMode ? (navState.examName           ?? null) : null;
  const templateMode:       'vju' | 'custom' = isGradingMode ? (navState.templateMode ?? 'vju') : 'vju';
  const customTemplateId:   number | null = isGradingMode ? (navState.customTemplateId   ?? null) : null;
  const customTemplateName: string | null = isGradingMode ? (navState.customTemplateName ?? null) : null;

  // 2026-07-29: when Answer Key is opened directly (sidebar link, not via
  // Upload → chấm phiếu), there's no navState at all, so the resolution
  // below used to just hardcode VJU_PRESET_SCHEMA — showing the wrong
  // question list for anyone actually using a custom template, forcing a
  // detour through the upload flow just to edit answers. Now it offers an
  // explicit dropdown (VJU preset + every custom template) so the user can
  // pick any one, defaulting to whichever they used most recently. Each
  // template's in-progress answers are kept in a separate draft slot (see
  // loadAnswerKeyDraft/saveAnswerKeyDraft) so switching between them in this
  // dropdown never loses or overwrites another template's work — only
  // "Lưu Answer Key" makes a template's answers the one actually used for
  // grading (unchanged from before).
  const [directTemplateKey, setDirectTemplateKey] = useState<TemplateStoreKey>(() => {
    if (isGradingMode) return 'vju';
    const last = loadLastUsedTemplate();
    return last ? templateStoreKeyFor(last.mode, last.id) : 'vju';
  });
  const [directSchema, setDirectSchema] = useState<TemplateSchema | null>(null);
  const [directSchemaLoading, setDirectSchemaLoading] = useState(false);
  // Sơ đồ vùng đọc của mẫu đang chọn — "GV cần nhìn được template đó là như
  // thế nào" trước khi bấm nhập đáp án cho nó. Reuses the same customFormsApi
  // fetch as directSchema below (no extra network round-trip).
  const [directAreas,  setDirectAreas]  = useState<TemplateAreaLike[] | null>(null);
  const [directPageW,  setDirectPageW]  = useState<number | null>(null);
  const [directPageH,  setDirectPageH]  = useState<number | null>(null);
  // Which picker tab is showing — mirrors the Upload page's "Mẫu phiếu VJU" /
  // "Custom template" tabs so both pages feel the same. Purely a UI concern;
  // `directTemplateKey` (above) is what actually drives the loaded schema.
  const [directTab, setDirectTab] = useState<'vju' | 'custom'>(() => {
    if (isGradingMode) return 'vju';
    const last = loadLastUsedTemplate();
    if (!last || last.mode !== 'custom' || last.id == null) return 'vju';
    // A pinned template (e.g. "Mẫu 40") is shown under the VJU tab, just like Upload.
    return PINNED_TEMPLATES.some(pt => pt.id === last.id) ? 'vju' : 'custom';
  });
  const [customFormOptions, setCustomFormOptions] = useState<CustomFormMeta[]>([]);
  const [customFormOptionsLoading, setCustomFormOptionsLoading] = useState(false);

  // Load the full custom-forms list — only needed outside the grading flow,
  // for the "Custom template" tab's dropdown.
  useEffect(() => {
    if (isGradingMode) return;
    setCustomFormOptionsLoading(true);
    customFormsApi.list()
      .then(({ forms }) => setCustomFormOptions(forms))
      .catch(() => setCustomFormOptions([]))
      .finally(() => setCustomFormOptionsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the schema for whichever template is currently selected in direct mode.
  useEffect(() => {
    if (isGradingMode) return;
    if (directTemplateKey === 'vju') { setDirectSchema(null); setDirectAreas(null); setDirectPageW(null); setDirectPageH(null); return; }
    const id = Number(directTemplateKey.slice('custom:'.length));
    if (!Number.isFinite(id)) { setDirectSchema(null); setDirectAreas(null); return; }
    setDirectSchemaLoading(true);
    customFormsApi.get(id)
      .then(detail => {
        setDirectSchema(buildSchemaFromDetail(detail));
        setDirectAreas((detail.areas as TemplateAreaLike[]) ?? null);
        setDirectPageW(detail.page_width  ?? null);
        setDirectPageH(detail.page_height ?? null);
      })
      .catch(() => { setDirectSchema(null); setDirectAreas(null); setDirectPageW(null); setDirectPageH(null); })
      .finally(() => setDirectSchemaLoading(false));
  }, [directTemplateKey, isGradingMode]);

  // Resolve template schema:
  // 1. navState.templateSchema (passed from SheetReviewPage) — primary
  // 2. sessionStorage (set by TemplatePage.handleLoad) — fallback
  // 3. null for custom (never fall back to VJU!) — show error
  // 4. directSchema — opened directly, dropdown-selected template is custom
  // 5. VJU_PRESET_SCHEMA otherwise
  const templateSchema: TemplateSchema | null = (() => {
    if (templateMode === 'custom') {
      const fromState   = isGradingMode ? (navState?.templateSchema ?? null) : null;
      const fromStorage = loadTemplateSchemaFromStorage(customTemplateId);
      const resolved    = fromState ?? fromStorage;
      console.log('[AnswerKeyPage] templateSchema', {
        templateMode, customTemplateId, customTemplateName,
        fromState: fromState ? `${fromState.infoFields.length} info, ${fromState.answerSections.length} sections` : null,
        fromStorage: fromStorage ? `${fromStorage.infoFields.length} info, ${fromStorage.answerSections.length} sections` : null,
      });
      return resolved;
    }
    if (!isGradingMode && directTemplateKey !== 'vju') return directSchema;
    return VJU_PRESET_SCHEMA;
  })();
  const activeSections = templateSchema?.answerSections ?? [];
  const activeLabels   = activeSections.flatMap(s => s.labels);
  // Labels whose choices are the standard A/B/C/D set — "Tất cả A/B/C/D"
  // quick-fill only applies to these (a Đúng/Sai section's options are
  // ["Đ","S"], so filling it with the letter "A" would be a bogus answer).
  const abcdLabels = activeSections
    .filter(s => s.inputType !== 'text' && (!s.options || (s.options.length === 4 && s.options.every((o, i) => o === ['A','B','C','D'][i]))))
    .flatMap(s => s.labels);

  // 2026-07-29: grouping every block into one flat grid still read as messy
  // once a phiếu mixes MCQ blocks with Đúng/Sai blocks with tự luận blocks —
  // "vẫn hơi rối, tạo kiểu thành các vùng (trắc nghiệm/đúng sai/...) đi". Add
  // a level above individual sections: bucket them by answer TYPE (MCQ choice
  // count, Đúng/Sai, hay tự luận) into named zones, each rendered as its own
  // bordered region with the section-grid inside — same data, clearer shape.
  function zoneForSection(s: typeof activeSections[number]): { key: string; label: string } {
    if (s.inputType === 'text') return { key: 'text', label: 'Tự luận / Số' };
    const opts = s.options && s.options.length > 0 ? s.options : ['A', 'B', 'C', 'D'];
    if (opts.length === 2) return { key: `bin:${opts.join('')}`, label: `Đúng / Sai (${opts.join('-')})` };
    const isAbcd = opts.length === 4 && opts.every((o, i) => o === ['A', 'B', 'C', 'D'][i]);
    return { key: `mcq:${opts.join('')}`, label: isAbcd ? 'Trắc nghiệm (A/B/C/D)' : `Trắc nghiệm (${opts.join('/')})` };
  }
  const sectionZones: { key: string; label: string; sections: typeof activeSections }[] = (() => {
    const order: string[] = [];
    const byKey = new Map<string, { key: string; label: string; sections: typeof activeSections }>();
    for (const s of activeSections) {
      const z = zoneForSection(s);
      if (!byKey.has(z.key)) { byKey.set(z.key, { ...z, sections: [] }); order.push(z.key); }
      byKey.get(z.key)!.sections.push(s);
    }
    return order.map(k => byKey.get(k)!);
  })();

  /** Draft for `key` if one was saved from the editor, else the single legacy
   *  "active" answer key when `key` is the VJU preset (backward compat for
   *  users who saved VJU answers before this per-template drafting existed). */
  function loadStoreForKey(key: TemplateStoreKey): AnswerKeyStore | null {
    const draft = loadAnswerKeyDraft(key);
    if (draft) return draft;
    if (key === 'vju') return loadAnswerKey();
    return null;
  }

  // grading: this kỳ thi + mẫu phiếu's own key (empty for a new one), not
  // whatever was saved last for another exam — see loadExamAnswerKey
  const gradingSlotKey = templateStoreKeyFor(templateMode, customTemplateId);
  const existing = isGradingMode ? loadExamAnswerKey(examId, gradingSlotKey) : loadStoreForKey(directTemplateKey);
  const canSplitByMaDe = schemaHasMaDe(templateSchema);

  const [answers,   setAnswers]   = useState<Record<string, string>>(() => existing?.answers ?? {});
  const [scoring,   setScoring]   = useState<ScoringWeights>(() => existing?.scoring ?? { ...DEFAULT_SCORING });
  const [savedAt,   setSavedAt]   = useState<string | null>(existing?.updatedAt ?? null);
  const [saveFlash, setSaveFlash] = useState(false);

  // ── Điểm riêng theo nhóm câu (2026-07-30) ─────────────────────────────────
  // "hiện tại đáp án chỉ cho điểm bằng nhau cho tất cả câu hỏi, cần có thể cho
  // giảng viên tích chọn hàng loạt và setup điểm cho chúng" — off by default
  // (every question still just uses the flat "Đúng" point value from Thang
  // điểm). Turning it on lets the question chips below become checkboxes;
  // whatever's ticked gets a custom point value applied in one go.
  const [pointSelectMode,   setPointSelectMode]   = useState(false);
  const [selectedForPoints, setSelectedForPoints] = useState<Set<string>>(new Set());
  const [bulkPointValue,    setBulkPointValue]    = useState('2');

  // ── Chia đáp án theo mã đề ────────────────────────────────────────────────
  // Off by default (single answer key, exactly the old behavior). Once turned
  // on, each "đề" (exam code) gets its own answers; the flat `answers` state
  // above is left untouched as a safety net until the user turns it back off.
  const [multiMaDe,     setMultiMaDe]     = useState<boolean>(() => isMultiMaDe(existing));
  const [maDeCodes,     setMaDeCodes]     = useState<string[]>(() => existing?.byMaDe ? Object.keys(existing.byMaDe) : []);
  const [activeMaDe,    setActiveMaDe]    = useState<string>(() => (existing?.byMaDe ? Object.keys(existing.byMaDe)[0] : '') ?? '');
  const [answersByMaDe, setAnswersByMaDe] = useState<Record<string, Record<string, string>>>(() => {
    const init: Record<string, Record<string, string>> = {};
    if (existing?.byMaDe) for (const [code, set] of Object.entries(existing.byMaDe)) init[code] = { ...set.answers };
    return init;
  });

  // ── Đáp án tự động từ bộ đề trộn (2026-09-29, bước 6.2) ────────────────────
  // "Xác nhận mã đề, đáp án — tự fill từ bước import đề và đáp án, không
  // import export ở đây, chỉ xem để giảng viên kiểm tra": when grading a kỳ
  // thi that has bộ đề trộn attached (Trộn đề page) on the "Mẫu 40 câu"
  // sheet, the answer key of every mã đề comes from those versions and is
  // shown read-only. Edits happen by re-mixing / re-attaching, not here.
  //
  // 2026-10-01: "lỡ tôi chấm cái phiếu này ko cùng cái nào khác thì sao ? t
  // sẽ ko đổi được à ?" — the bộ đề key stays the default, but the giảng viên
  // can step out of it for this đợt chấm ("Dùng đáp án khác"): the bộ đề
  // answers stay on screen as an editable starting point, the library /
  // Excel / typing work again, and "Dùng lại đáp án bộ đề" puts them back.
  // A sheet whose mã đề is not in the bộ đề is never graded with another
  // đề's key: it shows "Chưa có đáp án đề …" and lands in Cần review.
  type PaperKey = { byMaDe: Record<string, Record<string, string>>; papers: string[]; versions: string[] };
  const [paperFetched, setPaperFetched] = useState<PaperKey | null>(null);
  const [paperKey, setPaperKey] = useState<{ papers: string[]; versions: string[] } | null>(null);
  const paperLocked = paperKey !== null;
  const applyPaperKey = (k: PaperKey) => {
    setMultiMaDe(true);
    setMaDeCodes(k.versions);
    setAnswersByMaDe(k.byMaDe);
    setActiveMaDe(k.versions[0]);
    setSavedAt(null);
    setPaperKey({ papers: k.papers, versions: k.versions });
  };
  const leavePaperKey = () => {
    if (!confirm('Không dùng đáp án tự động của bộ đề cho kỳ thi này?\n\n'
      + (existing?.ownKey
        ? 'Đáp án đã lưu riêng cho kỳ thi này sẽ được mở lại. '
        : 'Đáp án bộ đề vẫn để trên màn hình để bạn sửa, hoặc nạp đáp án khác từ Thư viện / Import Excel. ')
      + 'Bộ đề ở trang Trộn đề không bị thay đổi; bấm "Dùng lại đáp án bộ đề" để quay lại.')) return;
    if (existing?.ownKey) {
      // back to this kỳ thi's own saved answers (e.g. the 101/102 imported earlier)
      const own = existing.byMaDe ?? {};
      setMultiMaDe(isMultiMaDe(existing));
      setMaDeCodes(Object.keys(own));
      setActiveMaDe(Object.keys(own)[0] ?? '');
      setAnswersByMaDe(Object.fromEntries(Object.entries(own).map(([c, set]) => [c, { ...set.answers }])));
      setAnswers(existing.answers ?? {});
    }
    setPaperKey(null);
    setSavedAt(null);
  };
  // 2026-10-05: "sao cái đáp án mã đề … bị fix cứng vậy": a kỳ thi's bộ đề
  // trộn was locking the đáp án whatever sheet was graded. Now only the bộ đề
  // mixed for THIS sheet count (Mẫu 40 câu ↔ Phiếu Bộ GD ↔ any other sheet), and a kỳ thi saved
  // with "Dùng đáp án khác" opens on its own answers (the bộ đề stays one
  // click away under "Dùng lại đáp án bộ đề").
  useEffect(() => {
    if (!isGradingMode || examId == null) return;
    if (templateMode !== 'custom' || customTemplateId == null) return;
    // any sheet: the bộ đề mixed for the template being graded
    examPapersApi.examAnswerKey(examId, customTemplateId)
      .then(k => {
        if (k.versions.length === 0) return;
        setPaperFetched(k);
        if (!existing?.ownKey) applyPaperKey(k);
      })
      .catch(() => { /* no bộ đề → normal manual answer key */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Ký tên giám thị & người chấm thi (2026-07-30) ─────────────────────────
  // "Ký tên giám thị và ng chấm thi" + "2 ng mỗi loại đề" — unlike Thang điểm
  // (shared across every đề), these names genuinely differ per đề (different
  // room/group can have different proctors), so they follow the same
  // per-mã-đề pattern as `answers`/`answersByMaDe` rather than `scoring`.
  const [proctors,      setProctors]      = useState<ProctorInfo>(() => existing?.proctors ?? {});
  const [proctorsByMaDe, setProctorsByMaDe] = useState<Record<string, ProctorInfo>>(() => {
    const init: Record<string, ProctorInfo> = {};
    if (existing?.byMaDe) for (const [code, set] of Object.entries(existing.byMaDe)) init[code] = { ...(set.proctors ?? {}) };
    return init;
  });

  // grading progress
  const [grading,   setGrading]   = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [gradingError, setGradingError] = useState<string | null>(null);

  const excelInputRef     = useRef<HTMLInputElement>(null);

  // ── Saved answer-key library (2026-07-29) ─────────────────────────────────
  const [library,      setLibrary]      = useState<SavedAnswerKeyEntry[]>(() => loadAnswerKeyLibrary());
  // 2026-09-29: "t muốn cái thư viện đáp án này nằm ở đầu trang answer key
  // cho dễ nhìn" — the library is now an always-visible card at the top of
  // the page (it used to be a toggle panel below the whole form). Shows the
  // most recent entries; "Xem tất cả" expands the rest.
  const LIBRARY_PREVIEW_COUNT = 3;
  const [showAllLibrary, setShowAllLibrary] = useState(false);
  const [previewEntry,  setPreviewEntry]  = useState<SavedAnswerKeyEntry | null>(null);
  const [previewMaDe,   setPreviewMaDe]   = useState<string>('');
  const [previewSchema, setPreviewSchema] = useState<TemplateSchema | null>(null);
  const [previewSchemaLoading, setPreviewSchemaLoading] = useState(false);
  // Editable copy of the entry being previewed ("có thể sửa được nữa") — kept
  // separate from the stored entry so edits don't silently persist until the
  // user explicitly hits "Lưu thay đổi". Flat + byMaDe kept side by side like
  // the main editor's answers/answersByMaDe so switching mã đề tabs inside
  // the popup never loses in-progress edits on another tab.
  const [previewAnswers,      setPreviewAnswers]      = useState<Record<string, string>>({});
  const [previewAnswersByMaDe, setPreviewAnswersByMaDe] = useState<Record<string, Record<string, string>>>({});
  const [previewDirty, setPreviewDirty] = useState(false);

  // Resolve the REAL schema (proper section names, "Câu N" ordering) for
  // whichever library entry is being previewed — reuses the current schema
  // when it's the same template already loaded, otherwise fetches it, so the
  // popup shows the same section names/labels as the actual editor screen
  // instead of raw technical labels guessed from the answer keys alone.
  useEffect(() => {
    if (!previewEntry) { setPreviewSchema(null); return; }
    const key = previewEntry.templateKey;
    if (key === 'vju') { setPreviewSchema(VJU_PRESET_SCHEMA); return; }
    if (key === directTemplateKey && templateSchema) { setPreviewSchema(templateSchema); return; }
    const id = Number(key.slice('custom:'.length));
    if (!Number.isFinite(id)) { setPreviewSchema(null); return; }
    setPreviewSchemaLoading(true);
    customFormsApi.get(id)
      .then(detail => setPreviewSchema(buildSchemaFromDetail(detail)))
      .catch(() => setPreviewSchema(null))
      .finally(() => setPreviewSchemaLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewEntry]);

  /** Display label for whichever template is currently loaded — used as the
   *  "Mẫu phiếu: ..." header inside the exported Excel and as the snapshot
   *  stored alongside a saved library entry. */
  const currentTemplateLabel = isGradingMode
    ? (templateMode === 'custom' && customTemplateName ? customTemplateName : TEMPLATE_VARIANT_LABEL[templateVariant])
    : (directTemplateKey === 'vju'
        ? 'Mẫu phiếu VJU'
        : (customFormOptions.find(f => templateStoreKeyFor('custom', f.id) === directTemplateKey)?.name
           // pinned templates (Mẫu 40) are shared, not in the user's own list
           ?? PINNED_TEMPLATES.find(pt => templateStoreKeyFor('custom', pt.id) === directTemplateKey)?.label
           ?? 'Custom template'));

  // 2026-07-30: "thế ko có cái chọn bộ đáp án để chấm à?" — the saved-answer-
  // key library was previously only reachable from the standalone Answer Key
  // page, not from this "xác nhận đáp án trước khi chấm" screen reached
  // straight from Upload, so there was no way to pick a previously-saved
  // answer key while setting up a grading run. In grading mode the template
  // is fixed (whatever Upload graded with) — not switchable like the direct-
  // open dropdown — so only library entries saved for that exact template
  // make sense to offer here.
  const currentGradingTemplateKey = isGradingMode ? templateStoreKeyFor(templateMode, customTemplateId) : null;
  const visibleLibrary = isGradingMode
    ? library.filter(e => e.templateKey === currentGradingTemplateKey)
    : library;

  // Answers currently being edited on screen — the active đề's set in multi-đề
  // mode, or the flat single-key set otherwise. Every read/write in the form
  // below goes through these two so the section-rendering JSX doesn't need to
  // know which mode it's in.
  const currentAnswers = multiMaDe ? (answersByMaDe[activeMaDe] ?? {}) : answers;

  const setAnswer = (label: string, val: string) => {
    if (paperLocked) return;   // answers come from the bộ đề trộn — view only
    const v = val === '—' ? '' : val;
    if (multiMaDe) {
      setAnswersByMaDe(prev => ({ ...prev, [activeMaDe]: { ...(prev[activeMaDe] ?? {}), [label]: v } }));
    } else {
      setAnswers(prev => ({ ...prev, [label]: v }));
    }
  };

  const currentProctors = multiMaDe ? (proctorsByMaDe[activeMaDe] ?? {}) : proctors;
  const setProctorField = (field: keyof ProctorInfo, val: boolean) => {
    if (multiMaDe) {
      setProctorsByMaDe(prev => ({ ...prev, [activeMaDe]: { ...(prev[activeMaDe] ?? {}), [field]: val } }));
    } else {
      setProctors(prev => ({ ...prev, [field]: val }));
    }
  };

  const setScoringField = (field: keyof ScoringWeights, val: string) => {
    const n = parseFloat(val);
    if (!isNaN(n)) setScoring(prev => ({ ...prev, [field]: n }));
  };

  const toggleLabelSelectedForPoints = (lbl: string) => {
    setSelectedForPoints(prev => {
      const next = new Set(prev);
      if (next.has(lbl)) next.delete(lbl); else next.add(lbl);
      return next;
    });
  };
  const applyBulkPoints = () => {
    const val = parseFloat(bulkPointValue);
    if (Number.isNaN(val) || selectedForPoints.size === 0) return;
    setScoring(prev => ({
      ...prev,
      questionPoints: { ...(prev.questionPoints ?? {}), ...Object.fromEntries([...selectedForPoints].map(l => [l, val])) },
    }));
    setSelectedForPoints(new Set());
  };
  const clearSelectedPointOverrides = () => {
    setScoring(prev => {
      const qp = { ...(prev.questionPoints ?? {}) };
      for (const l of selectedForPoints) delete qp[l];
      return { ...prev, questionPoints: qp };
    });
    setSelectedForPoints(new Set());
  };
  const clearAllPointOverrides = () => setScoring(prev => ({ ...prev, questionPoints: {} }));
  const overrideCount = Object.keys(scoring.questionPoints ?? {}).filter(l => scoring.questionPoints?.[l] != null).length;

  /**
   * Builds the full store to persist — flat single key, or byMaDe map.
   * NOTE: when saving in multi-đề mode, the flat `answers` field is kept as-is
   * (not wiped to {}) even though scoring ignores it while byMaDe has entries —
   * it's a safety-net backup of whatever single answer key existed before the
   * user turned on mã-đề splitting, so nothing is silently lost if they turn
   * it back off, and so old JSON exports of it aren't clobbered.
   */
  const buildStore = (): AnswerKeyStore => {
    const now = new Date().toISOString();
    if (multiMaDe && maDeCodes.length > 0) {
      const byMaDe: Record<string, AnswerKeySet> = {};
      for (const code of maDeCodes) {
        byMaDe[code] = { answers: answersByMaDe[code] ?? {}, scoring, updatedAt: now, proctors: proctorsByMaDe[code] ?? {} };
      }
      return { answers, scoring, updatedAt: now, byMaDe, proctors };
    }
    return { answers, scoring, updatedAt: now, proctors };
  };

  // Re-populate all answer-editing state whenever the dropdown-selected
  // template changes (direct-open mode only — grading mode's answers are
  // fixed to whatever template Upload passed in and never switch).
  useEffect(() => {
    if (isGradingMode) return;
    const store = loadStoreForKey(directTemplateKey);
    setAnswers(store?.answers ?? {});
    setScoring(store?.scoring ?? { ...DEFAULT_SCORING });
    setSavedAt(store?.updatedAt ?? null);
    setMultiMaDe(isMultiMaDe(store));
    setMaDeCodes(store?.byMaDe ? Object.keys(store.byMaDe) : []);
    setActiveMaDe(store?.byMaDe ? (Object.keys(store.byMaDe)[0] ?? '') : '');
    const init: Record<string, Record<string, string>> = {};
    if (store?.byMaDe) for (const [code, set] of Object.entries(store.byMaDe)) init[code] = { ...set.answers };
    setAnswersByMaDe(init);
    setProctors(store?.proctors ?? {});
    const proctorInit: Record<string, ProctorInfo> = {};
    if (store?.byMaDe) for (const [code, set] of Object.entries(store.byMaDe)) proctorInit[code] = { ...(set.proctors ?? {}) };
    setProctorsByMaDe(proctorInit);
    // 2026-07-30 bug fix: this used to NOT reset the "chọn theo nhóm câu"
    // checkbox selection when switching templates. The question-label chips
    // shown in the UI change per template, but `selectedForPoints` is a raw
    // Set<string> of labels — if a teacher had e.g. "cnnn2","cnnn3" ticked on
    // the VJU template, switched to a custom template, ticked a few of ITS
    // labels, then hit "Áp dụng điểm", both old and new labels got written
    // into the same questionPoints object together — the old template's
    // question keys silently rode along ("Hệ số riêng: cnnn2=+2, ..." showing
    // up next to a completely different template's "Câu N" overrides in the
    // Excel export). Clearing the selection here is the actual fix; see
    // activeQuestionPoints() in types/grading.ts for a defensive filter that
    // also hides any such leftovers already saved before this fix.
    setSelectedForPoints(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directTemplateKey, isGradingMode]);

  /** Dropdown "Mẫu phiếu" onChange — saves the outgoing template's in-progress
   *  edits as its own draft first, so switching back later restores them. */
  const handleTemplateKeyChange = (newKey: TemplateStoreKey) => {
    if (newKey === directTemplateKey) return;
    saveAnswerKeyDraft(directTemplateKey, buildStore());
    setDirectTemplateKey(newKey);
  };

  // ── Mã đề tab management ─────────────────────────────────────────────────
  const startSplitByMaDe = () => {
    const code = (window.prompt('Nhập mã đề hiện tại (VD: 101) — đáp án đã nhập ở trên sẽ chuyển vào đề này:') ?? '').trim();
    if (!code) return;
    setAnswersByMaDe({ [code]: { ...answers } });
    setProctorsByMaDe({ [code]: { ...proctors } });
    setMaDeCodes([code]);
    setActiveMaDe(code);
    setMultiMaDe(true);
  };

  const addMaDeTab = () => {
    const code = (window.prompt('Nhập mã đề mới (VD: 102):') ?? '').trim();
    if (!code) return;
    if (maDeCodes.includes(code)) { setActiveMaDe(code); return; }
    setMaDeCodes(prev => [...prev, code]);
    setAnswersByMaDe(prev => ({ ...prev, [code]: {} }));
    setProctorsByMaDe(prev => ({ ...prev, [code]: {} }));
    setActiveMaDe(code);
  };

  const removeMaDeTab = (code: string) => {
    if (!confirm(`Xóa đáp án đề ${code}?`)) return;
    const remaining = maDeCodes.filter(c => c !== code);
    setMaDeCodes(remaining);
    setAnswersByMaDe(prev => { const next = { ...prev }; delete next[code]; return next; });
    setProctorsByMaDe(prev => { const next = { ...prev }; delete next[code]; return next; });
    if (activeMaDe === code) setActiveMaDe(remaining[0] ?? '');
    if (remaining.length === 0) setMultiMaDe(false);
  };

  const stopSplitByMaDe = () => {
    if (!confirm('Tắt chia theo mã đề? Đáp án của đề đang chọn sẽ giữ lại làm bộ đáp án chung, các đề khác sẽ bị xóa.')) return;
    setAnswers(answersByMaDe[activeMaDe] ?? {});
    setProctors(proctorsByMaDe[activeMaDe] ?? {});
    setMultiMaDe(false);
    setMaDeCodes([]);
    setAnswersByMaDe({});
    setProctorsByMaDe({});
    setActiveMaDe('');
  };

  const copyFromMaDe = (fromCode: string) => {
    if (!fromCode || fromCode === activeMaDe) return;
    if (!confirm(`Ghi đè đáp án đề ${activeMaDe} bằng đáp án đề ${fromCode}?`)) return;
    setAnswersByMaDe(prev => ({ ...prev, [activeMaDe]: { ...(prev[fromCode] ?? {}) } }));
  };

  /** Keep a library copy of every saved answer key (see upsertAutoLibraryEntry).
   *  Named "<kỳ thi> – <mẫu phiếu>" (just the mẫu outside the grading flow). */
  const autoSaveToLibrary = (store: AnswerKeyStore) => {
    const hasAnswers = Object.values(store.answers).some(Boolean)
      || Object.values(store.byMaDe ?? {}).some(set => Object.values(set.answers).some(Boolean));
    if (!hasAnswers) return;
    const templateKey = isGradingMode ? templateStoreKeyFor(templateMode, customTemplateId) : directTemplateKey;
    setLibrary(upsertAutoLibraryEntry(`${examId ?? 'none'}|${templateKey}`, {
      name: examName ? `${examName} – ${currentTemplateLabel}` : currentTemplateLabel,
      templateKey,
      templateLabel: currentTemplateLabel,
      store,
    }));
  };

  const handleSave = () => {
    const store = buildStore();
    autoSaveToLibrary(store);
    // Always write the single "active" key — every scoring/results/analytics
    // page reads this one, so saving here is what actually makes this
    // template's answers the one used for grading (unchanged from before).
    saveAnswerKey(store);
    // Also keep this template's own draft in sync, so switching away and
    // back via the dropdown shows the just-saved answers, not a stale draft.
    if (!isGradingMode) saveAnswerKeyDraft(directTemplateKey, store);
    else saveExamAnswerKey(examId, gradingSlotKey, { ...store, ownKey: !paperLocked && paperFetched != null });
    setSavedAt(store.updatedAt);
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 2000);
  };

  const handleClear = () => {
    if (paperLocked) return;
    if (!confirm('Xóa toàn bộ answer key?')) return;
    clearAnswerKey();
    if (!isGradingMode) clearAnswerKeyDraft(directTemplateKey);
    setAnswers({});
    setScoring({ ...DEFAULT_SCORING });
    setSavedAt(null);
    setMultiMaDe(false);
    setMaDeCodes([]);
    setAnswersByMaDe({});
    setActiveMaDe('');
  };

  // ── Excel import/export (2026-07-29) — primary format for teachers, who
  // don't work with raw JSON. Mirrors the current template's own sections/
  // labels/mã đề (never a fixed layout), matching this editor screen. ──────

  const handleExportExcel = async () => {
    if (!templateSchema) { alert('Chưa xác định được mẫu phiếu — không thể xuất Excel.'); return; }
    const store = buildStore();
    const wb  = buildAnswerKeyWorkbook(templateSchema, store, currentTemplateLabel);
    const buf = await wb.xlsx.writeBuffer();
    saveAs(new Blob([buf], { type: 'application/octet-stream' }), 'vju_answer_key.xlsx');
  };

  const handleSampleExcelDownload = async () => {
    const schemaForSample = templateSchema ?? VJU_PRESET_SCHEMA;
    const wb  = buildAnswerKeySampleWorkbook(schemaForSample, currentTemplateLabel);
    const buf = await wb.xlsx.writeBuffer();
    saveAs(new Blob([buf], { type: 'application/octet-stream' }), 'vju_answer_key_mau.xlsx');
  };

  // 2026-10-05: "t import excel 101 vào mà … nó ko đổi theo cái t import
  // vào" / "t import thêm cái khác nó phải tự thêm cái khác chứ": a file
  // holding ONE đề's answers used to land in whichever tab happened to be
  // open. Now the mã đề is read from the file name ("Dap_an_Ma_de_101.xlsx",
  // "de 102.xlsx" …), asked when the name has none, and the answers go to
  // that tab: a new mã đề is ADDED next to the others, an existing one is
  // replaced (and the message says so). Several files can be picked at once.
  // A file with "Đề 101", "Đề 102" sheets (this page's own multi-đề export)
  // still replaces the whole set.
  const maDeFromFileName = (name: string): string | null => {
    // drop the extension and a browser's " (1)" duplicate-download suffix
    const base = name.replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)$/, '').trim();
    const m = base.match(/(?:m[aã][\s_-]*)?(?:đ[eềể]|de)(?:[\s_-]*thi)?[\s_-]*(\d{2,6})(?!.*\d)/i)
      ?? base.match(/^(\d{2,6})$/);   // a file named just "101.xlsx"
    return m ? m[1] : null;
  };

  const handleImportExcelFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (paperLocked) { e.target.value = ''; return; }
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    if (!templateSchema) { alert('Chưa xác định được mẫu phiếu — không thể import Excel.'); return; }
    const allWarnings: string[] = [];
    const perCode: { code: string; answers: Record<string, string>; file: string }[] = [];
    let lastScoring: ScoringWeights | null = null;
    try {
      for (const file of files) {
        const { store: parsed, warnings } = await parseAnswerKeyWorkbook(file, templateSchema);
        allWarnings.push(...warnings.map(w => (files.length > 1 ? `${file.name}: ${w}` : w)));
        lastScoring = parsed.scoring;
        if (parsed.byMaDe && Object.keys(parsed.byMaDe).length > 0) {
          // a whole multi-đề set: replaces what's on screen
          const codes = Object.keys(parsed.byMaDe);
          const rebuilt: Record<string, Record<string, string>> = {};
          for (const c of codes) rebuilt[c] = parsed.byMaDe[c]?.answers ?? {};
          setAnswersByMaDe(rebuilt);
          setMaDeCodes(codes);
          setActiveMaDe(codes[0]);
          setMultiMaDe(true);
          continue;
        }
        let code = maDeFromFileName(file.name);
        if (!code) {
          code = (window.prompt(
            `File "${file.name}" là đáp án của mã đề nào? (VD: 101)`
            + (multiMaDe ? '' : '\nĐể trống nếu đề thi chỉ có một mã đề.'), '') ?? '').trim() || null;
        }
        if (code) perCode.push({ code, answers: parsed.answers, file: file.name });
        else if (multiMaDe) allWarnings.push(`${file.name}: chưa nhập mã đề nên bỏ qua file này.`);
        else setAnswers(parsed.answers);   // one đề only, no mã đề: the plain answer key
      }
    } catch {
      alert('Không đọc được file Excel này. Kiểm tra lại file (.xlsx) và thử lại.');
      return;
    }

    // a mã đề already on the page with answers in it is replaced, the rest are added
    const had = multiMaDe ? maDeCodes : [];
    const replaced = perCode.filter(x => had.includes(x.code)
      && Object.values(answersByMaDe[x.code] ?? {}).some(v => v)).map(x => x.code);
    if (perCode.length > 0) {
      const codes = [...had, ...perCode.map(x => x.code).filter(c => !had.includes(c))];
      setAnswersByMaDe(prev => {
        const next = { ...prev };
        for (const x of perCode) next[x.code] = x.answers;
        return next;
      });
      setProctorsByMaDe(prev => {
        const next = { ...prev };
        for (const c of codes) next[c] = prev[c] ?? {};
        return next;
      });
      setMaDeCodes(codes);
      setActiveMaDe(perCode[perCode.length - 1].code);
      setMultiMaDe(true);
    }
    if (lastScoring) setScoring(lastScoring);
    setSavedAt(null);
    const done = perCode.length > 0
      ? `Đã nạp đáp án: ${perCode.map(x => `${x.file} → Đề ${x.code}`).join(', ')}.`
        + (replaced.length > 0 ? `\nĐề ${replaced.join(', ')} đã có đáp án từ trước, đã được thay bằng file mới.` : '')
      : 'Đã import xong.';
    if (allWarnings.length > 0) {
      alert(`${done}\n\nCó ${allWarnings.length} cảnh báo:\n\n${allWarnings.slice(0, 10).join('\n')}${allWarnings.length > 10 ? `\n… và ${allWarnings.length - 10} dòng khác.` : ''}`);
    } else if (perCode.length > 0) {
      alert(done);
    }
  };

  // ── Saved answer-key library ──────────────────────────────────────────────

  const handleSaveToLibrary = () => {
    const name = (window.prompt('Đặt tên cho đáp án này để tra cứu lại sau (VD: "Đáp án Toán K12 - Cuối kì HK1"):') ?? '').trim();
    if (!name) return;
    const store = buildStore();
    const entry = addToAnswerKeyLibrary({
      name,
      templateKey:   isGradingMode ? templateStoreKeyFor(templateMode, customTemplateId) : directTemplateKey,
      templateLabel: currentTemplateLabel,
      store,
    });
    setLibrary(prev => [entry, ...prev]);
  };

  const handleLoadFromLibrary = (entry: SavedAnswerKeyEntry) => {
    if (paperLocked) {
      alert('Đáp án đang lấy tự động từ bộ đề trộn. Muốn nạp đáp án khác cho lần chấm này, bấm "Dùng đáp án khác" ở khung xanh trước.');
      return;
    }
    if (isGradingMode) {
      // No template-switch branch here on purpose — grading mode's template
      // is fixed to whatever Upload already graded with, so an entry saved
      // for a different template can't be applied (the panel below only
      // lists matching entries in the first place, but double-check here
      // too since this handler is also reachable from the preview modal's
      // "Nạp vào để dùng").
      if (entry.templateKey !== currentGradingTemplateKey) {
        alert(`Đáp án "${entry.name}" được lưu cho mẫu "${entry.templateLabel}" — khác với mẫu đang chấm ("${currentTemplateLabel}"). Không thể dùng cho đợt chấm này.`);
        return;
      }
      if (!confirm(`Nạp đáp án "${entry.name}" để dùng cho đợt chấm này? Đáp án đang nhập trên màn hình (nếu có) sẽ bị ghi đè.`)) return;
      setAnswers(entry.store.answers);
      setScoring(entry.store.scoring);
      setSavedAt(null);
      setMultiMaDe(isMultiMaDe(entry.store));
      setMaDeCodes(entry.store.byMaDe ? Object.keys(entry.store.byMaDe) : []);
      setActiveMaDe(entry.store.byMaDe ? (Object.keys(entry.store.byMaDe)[0] ?? '') : '');
      const gradingInit: Record<string, Record<string, string>> = {};
      if (entry.store.byMaDe) for (const [code, set] of Object.entries(entry.store.byMaDe)) gradingInit[code] = { ...set.answers };
      setAnswersByMaDe(gradingInit);
      setProctors(entry.store.proctors ?? {});
      const gradingProctorInit: Record<string, ProctorInfo> = {};
      if (entry.store.byMaDe) for (const [code, set] of Object.entries(entry.store.byMaDe)) gradingProctorInit[code] = { ...(set.proctors ?? {}) };
      setProctorsByMaDe(gradingProctorInit);
      return;
    }
    if (!confirm(`Nạp đáp án "${entry.name}" (${entry.templateLabel})? Bản nháp đang có của mẫu đó (nếu có) sẽ bị ghi đè bằng đáp án đã lưu này.`)) return;
    saveAnswerKeyDraft(entry.templateKey, entry.store);
    if (entry.templateKey === directTemplateKey) {
      setAnswers(entry.store.answers);
      setScoring(entry.store.scoring);
      setSavedAt(null);
      setMultiMaDe(isMultiMaDe(entry.store));
      setMaDeCodes(entry.store.byMaDe ? Object.keys(entry.store.byMaDe) : []);
      setActiveMaDe(entry.store.byMaDe ? (Object.keys(entry.store.byMaDe)[0] ?? '') : '');
      const init: Record<string, Record<string, string>> = {};
      if (entry.store.byMaDe) for (const [code, set] of Object.entries(entry.store.byMaDe)) init[code] = { ...set.answers };
      setAnswersByMaDe(init);
    } else {
      const isPinned = PINNED_TEMPLATES.some(pt => templateStoreKeyFor('custom', pt.id) === entry.templateKey);
      setDirectTab(entry.templateKey === 'vju' || isPinned ? 'vju' : 'custom');
      setDirectTemplateKey(entry.templateKey); // triggers the reload effect, which picks up the draft just saved above
    }
  };

  const handleRenamePreviewEntry = () => {
    if (!previewEntry) return;
    const name = (window.prompt('Đổi tên đáp án:', previewEntry.name) ?? '').trim();
    if (!name || name === previewEntry.name) return;
    const updated = renameAnswerKeyLibraryEntry(previewEntry.id, name);
    if (updated) {
      setLibrary(prev => prev.map(e => (e.id === updated.id ? updated : e)));
      setPreviewEntry(updated);
    }
  };

  const handleDeleteFromLibrary = (id: string) => {
    if (!confirm('Xoá đáp án này khỏi thư viện? (Không ảnh hưởng đáp án đang dùng để chấm.)')) return;
    removeFromAnswerKeyLibrary(id);
    setLibrary(prev => prev.filter(e => e.id !== id));
    if (previewEntry?.id === id) setPreviewEntry(null);
  };

  const openLibraryPreview = (entry: SavedAnswerKeyEntry) => {
    setPreviewEntry(entry);
    const codes = entry.store.byMaDe ? Object.keys(entry.store.byMaDe) : [];
    setPreviewMaDe(codes[0] ?? '');
    setPreviewAnswers({ ...entry.store.answers });
    const init: Record<string, Record<string, string>> = {};
    if (entry.store.byMaDe) for (const [code, set] of Object.entries(entry.store.byMaDe)) init[code] = { ...set.answers };
    setPreviewAnswersByMaDe(init);
    setPreviewDirty(false);
  };

  /** Closes the popup, confirming first if there are unsaved inline edits. */
  const closePreviewModal = () => {
    if (previewDirty && !confirm('Đóng mà không lưu thay đổi vừa sửa?')) return;
    setPreviewEntry(null);
  };

  const isPreviewMulti = (entry: SavedAnswerKeyEntry): boolean =>
    !!entry.store.byMaDe && Object.keys(entry.store.byMaDe).length > 0;

  const setPreviewAnswer = (lbl: string, val: string) => {
    if (!previewEntry) return;
    const v = val === '—' ? '' : val;
    setPreviewDirty(true);
    if (isPreviewMulti(previewEntry)) {
      setPreviewAnswersByMaDe(prev => ({ ...prev, [previewMaDe]: { ...(prev[previewMaDe] ?? {}), [lbl]: v } }));
    } else {
      setPreviewAnswers(prev => ({ ...prev, [lbl]: v }));
    }
  };

  /** Persists the inline edits back into the library entry itself. Returns
   *  the updated entry so callers (e.g. "Nạp vào để dùng") can chain off it
   *  without re-reading stale state. */
  const handleSavePreviewChanges = (): SavedAnswerKeyEntry | null => {
    if (!previewEntry) return null;
    const now = new Date().toISOString();
    let newStore: AnswerKeyStore;
    if (isPreviewMulti(previewEntry)) {
      const byMaDe: Record<string, AnswerKeySet> = {};
      for (const [code, set] of Object.entries(previewEntry.store.byMaDe!)) {
        byMaDe[code] = { ...set, answers: previewAnswersByMaDe[code] ?? set.answers, updatedAt: now };
      }
      newStore = { ...previewEntry.store, byMaDe, updatedAt: now };
    } else {
      newStore = { ...previewEntry.store, answers: previewAnswers, updatedAt: now };
    }
    const updated = updateAnswerKeyLibraryEntry(previewEntry.id, newStore);
    if (updated) {
      setLibrary(prev => prev.map(e => (e.id === updated.id ? updated : e)));
      setPreviewEntry(updated);
      setPreviewDirty(false);
    }
    return updated;
  };

  /** "Nạp vào để dùng" — saves any pending inline edits first so the main
   *  editor picks up what's actually on screen, not the stale saved copy. */
  const handleUseInMainEditor = () => {
    if (!previewEntry) return;
    const target = previewDirty ? handleSavePreviewChanges() : previewEntry;
    if (target) { handleLoadFromLibrary(target); setPreviewEntry(null); }
  };

  /** Stub error row helper */
  const _errRow = (filename: string, msg: string): OmrGradeResult => ({
    input:        { filename, saved_as: '' },
    student_info: { cccd: null, sbd: null, ma_de: null, ca_thi: null, ma_ctdt: null, tu_chon: null },
    answers: {}, warnings: [],
    score:   { total: null, max: null, correct: null, wrong: null, blank: null },
    debug:   {
      threshold: 0, mean_mode: '', prep_method: '', alignment_info: '', alignment_warnings: [],
      image_source: null, preprocess_strategy_used: null,
      marker_centers_detected: null, target_marker_centers: null, homography_matrix: null,
      marker_quality_score: null, warp_used: null, warp_rejected_reason: null,
      original_image_path: null, aligned_image_path: null, aligned_candidate_path: null,
      overlay_all_path: null, markers_debug_path: null,
      overlay_marked_only_path: null, overlay_warnings_path: null, means_json_path: null,
    },
    _error:  msg,
  });

  /** Save answer key then call API for each file, navigate to /app/results */
  const handleGradeNow = async () => {
    if (gradingFiles.length === 0) return;

    // Save answer key first
    const store = buildStore();
    saveAnswerKey(store);
    saveExamAnswerKey(examId, gradingSlotKey, { ...store, ownKey: !paperLocked && paperFetched != null });
    autoSaveToLibrary(store);
    setSavedAt(store.updatedAt);

    setGrading(true);
    setDoneCount(0);
    setGradingError(null);

    // 2026-08-03: "để câu đúng xanh câu sai đỏ câu lỗi vàng" — the backend
    // now colors the "Ảnh detect" overlay by correctness when an answer key
    // is sent with the grading request (see omr.py's debug-grade route +
    // engine.py). Multi-mã-đề exams can't resolve which flat key applies
    // until the sheet's mã đề is detected server-side, so send a wrapper
    // instead of a flat key in that case — engine.py resolves it after
    // reading the mã đề (see engine.py _execute() Step 8).
    const answerKeyPayload = isMultiMaDe(store)
      ? {
          byMaDe: Object.fromEntries(
            Object.entries(store.byMaDe ?? {}).map(([maDe, set]) => [maDe, set.answers]),
          ),
          // no "default": a sheet whose mã đề has no answer set must not be
          // scored / colored with the (stale) single key — the Results page
          // shows it as "Chưa có đáp án đề …" and sends it to Cần review
        }
      : (store.answers && Object.keys(store.answers).length > 0 ? store.answers : null);
    const answerKeyParam = answerKeyPayload
      ? `&answer_key_json=${encodeURIComponent(JSON.stringify(answerKeyPayload))}`
      : '';

    const results: OmrGradeResult[] = [];

    for (const rawFile of gradingFiles) {
      const originalName = rawFile instanceof File ? rawFile.name : String((rawFile as { name?: string }).name ?? 'unknown');

      // ── 1. Validate + convert (HEIC→JPEG, invalid File, PDF) ──
      let uploadFile: File;
      if (!(rawFile instanceof File)) {
        results.push(_errRow(originalName, 'File không còn hợp lệ — quay lại Upload và chọn lại file.'));
        setDoneCount(c => c + 1);
        continue;
      }
      const norm = await normalizeUploadFile(rawFile);
      if (!norm.ok) {
        results.push(_errRow(originalName, norm.error));
        setDoneCount(c => c + 1);
        continue;
      }
      uploadFile = norm.file;

      // ── 2. Send to API ──
      const formData = new FormData();
      formData.append('image', uploadFile);
      try {
        const url = templateMode === 'custom' && customTemplateId != null
          ? `${API_BASE}?mean_mode=circle_mask&full_debug=true&template_id=${customTemplateId}&image_source=${imageSource}${answerKeyParam}`
          : `${API_BASE}?mean_mode=circle_mask&full_debug=true&template_variant=${templateVariant}&image_source=${imageSource}${answerKeyParam}`;
        const res = await fetch(url, { method: 'POST', body: formData });
        if (!res.ok) {
          const errText = await res.text();
          results.push(_errRow(originalName, `HTTP ${res.status}: ${errText.slice(0, 200)}`));
        } else {
          const data = await res.json() as OmrGradeResult;
          // Restore original filename so ResultsPage shows the real name
          results.push({ ...data, input: { ...data.input, filename: originalName } });
        }
      } catch (err) {
        results.push(_errRow(originalName, String(err)));
      }
      setDoneCount(c => c + 1);
    }

    const batch: BatchGradeState = {
      templateVariant,
      results,
      gradedAt: new Date().toISOString(),
      examId:              examId             ?? null,
      examName:            examName           ?? null,
      templateMode:        templateMode,
      customTemplateId:    customTemplateId   ?? null,
      customTemplateName:  customTemplateName ?? null,
      templateSchema:      templateMode === 'custom' ? templateSchema : null,
    };

    try { localStorage.setItem(BATCH_LS_KEY, JSON.stringify(batch)); } catch { /* ignore */ }
    setGrading(false);
    console.log('[AnswerKeyPage] BatchGradeState', batch);
    navigate('/app/results', { state: batch });
  };

  const filled = activeLabels.filter(l => currentAnswers[l]).length;
  const total  = activeLabels.length;

  const primaryButton = isGradingMode ? (
    grading ? (
      <Button
        size="sm"
        disabled
        icon={<Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
        style={{ background: '#C8102E', color: '#fff', borderColor: '#C8102E', fontWeight: 700 }}
      >
        Đang chấm {doneCount}/{gradingFiles.length}…
      </Button>
    ) : (
      <Button
        size="sm"
        icon={<Zap size={14} />}
        onClick={handleGradeNow}
        style={{ background: '#C8102E', color: '#fff', borderColor: '#C8102E', fontWeight: 700 }}
      >
        Lưu & Bắt đầu chấm ({gradingFiles.length} phiếu)
      </Button>
    )
  ) : (
    <Button
      size="sm"
      icon={saveFlash ? <CheckCircle2 size={14} /> : <Save size={14} />}
      onClick={handleSave}
      style={{
        background:  saveFlash ? '#10B981' : '#C8102E',
        color:       '#fff',
        borderColor: saveFlash ? '#10B981' : '#C8102E',
        fontWeight:  700,
      }}
    >
      {saveFlash ? 'Đã lưu!' : 'Lưu Answer Key'}
    </Button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title="Answer Key"
        subtitle={isGradingMode
          ? `Xác nhận đáp án trước khi chấm — ${gradingFiles.length} file · ${
              templateMode === 'custom' && customTemplateName
                ? `Custom: ${customTemplateName}`
                : TEMPLATE_VARIANT_LABEL[templateVariant]
            }`
          : 'Nhập đáp án đúng, import/export Excel và thiết lập thang điểm'}
        actions={isGradingMode ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<ArrowLeft size={14} />}
            onClick={() => navigate('/app/sheet-review')}
          >
            Quay lại Upload
          </Button>
        ) : undefined}
      />

      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Thư viện đáp án — top of the page so saved answer keys are the
            first thing a teacher sees. In grading mode (fixed template) only
            entries saved for that exact template are listed, since there's no
            way to switch templates mid-grading to use the rest. */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: visibleLibrary.length ? 12 : 6 }}>
            <Library size={16} color="#C8102E" style={{ flexShrink: 0 }} />
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#374151', flex: 1, minWidth: 180 }}>
              Thư viện đáp án {visibleLibrary.length > 0 && <span style={{ color: '#9CA3AF', fontWeight: 600 }}>({visibleLibrary.length})</span>}
              {isGradingMode && <span style={{ fontWeight: 500, color: '#9CA3AF' }}> (đáp án đã lưu cho mẫu đang chấm: {currentTemplateLabel})</span>}
            </h3>
            <Button size="sm" variant="secondary" icon={<BookmarkPlus size={14} />} onClick={handleSaveToLibrary}>Lưu vào thư viện</Button>
          </div>
          {visibleLibrary.length === 0 ? (
            <div style={{ fontSize: 13, color: '#9CA3AF' }}>
              {isGradingMode
                ? `Chưa có đáp án nào được lưu cho mẫu "${currentTemplateLabel}". Bấm "Lưu & Bắt đầu chấm" hoặc "Lưu vào thư viện" để lưu lại dùng cho lần sau.`
                : 'Chưa có đáp án nào. Bấm "Lưu Answer Key" (tự lưu vào đây) hoặc "Lưu vào thư viện" để đặt tên riêng.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(showAllLibrary ? visibleLibrary : visibleLibrary.slice(0, LIBRARY_PREVIEW_COUNT)).map(entry => (
                <div key={entry.id}
                  onClick={() => openLibraryPreview(entry)}
                  title="Bấm để xem chi tiết"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', flexWrap: 'wrap',
                    padding: '10px 14px', borderRadius: 10, border: '1.5px solid #E5E7EB',
                  }}
                >
                  <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</div>
                    <div style={{ fontSize: 12, color: '#9CA3AF' }}>
                      {entry.templateLabel} · Lưu lúc {new Date(entry.savedAt).toLocaleString('vi-VN', { hour12: false })}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); handleLoadFromLibrary(entry); }}>Nạp vào</Button>
                  <Button size="sm" variant="secondary" icon={<Trash2 size={13} />} title="Xóa khỏi thư viện" onClick={e => { e.stopPropagation(); handleDeleteFromLibrary(entry.id); }} style={{ color: '#EF4444', borderColor: '#FECACA' }} />
                </div>
              ))}
              {visibleLibrary.length > LIBRARY_PREVIEW_COUNT && (
                <button type="button" onClick={() => setShowAllLibrary(v => !v)}
                  style={{ alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', color: '#C8102E', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, padding: '2px 0' }}>
                  {showAllLibrary ? 'Thu gọn' : `Xem tất cả (${visibleLibrary.length})`}
                </button>
              )}
            </div>
          )}
        </Card>

        {/* Opened directly (not via Upload flow): pick which template's answer key to edit.
            Mirrors the Upload page's own picker (same 2 tabs + pinned "Mẫu 40" option) so
            both pages feel consistent, instead of a flat dropdown listing every custom
            template ever created (confusing once there are several old/test ones). */}
        {!isGradingMode && (
          <Card>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#C8102E', marginBottom: 12 }}>Mẫu phiếu</div>

            {/* 2026-07-30: same two-column layout as the Upload page's picker
               — the picker on the left, a bigger live preview on the right,
               so a real reference photo is actually legible instead of a
               130px-tall thumbnail stacked under the picker. */}
            <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 360px', minWidth: 300 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  {([
                    { value: 'vju' as const,    label: 'Mẫu phiếu VJU' },
                    { value: 'custom' as const, label: 'Custom template' },
                  ]).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setDirectTab(opt.value)}
                      style={{
                        padding: '7px 16px', borderRadius: 9999, fontSize: 13, fontWeight: 600,
                        border: `1.5px solid ${directTab === opt.value ? '#C8102E' : '#E5E7EB'}`,
                        background: directTab === opt.value ? '#FEF2F2' : '#fff',
                        color: directTab === opt.value ? '#C8102E' : '#374151',
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {directTab === 'vju' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: directTemplateKey === 'vju' ? 700 : 400, color: directTemplateKey === 'vju' ? '#C8102E' : '#374151' }}>
                      <input
                        type="radio" name="direct-template"
                        checked={directTemplateKey === 'vju'}
                        onChange={() => handleTemplateKeyChange('vju')}
                        style={{ accentColor: '#C8102E' }}
                      />
                      VJU mặc định
                    </label>
                    {PINNED_TEMPLATES.map(pt => {
                      const key = templateStoreKeyFor('custom', pt.id);
                      return (
                        <label key={pt.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: directTemplateKey === key ? 700 : 400, color: directTemplateKey === key ? '#C8102E' : '#374151' }}>
                          <input
                            type="radio" name="direct-template"
                            checked={directTemplateKey === key}
                            onChange={() => handleTemplateKeyChange(key)}
                            style={{ accentColor: '#C8102E' }}
                          />
                          {pt.label}
                        </label>
                      );
                    })}
                    {directSchemaLoading && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#6B7280' }}>
                        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                        Đang tải…
                      </span>
                    )}
                  </div>
                )}

                {directTab === 'custom' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {customFormOptionsLoading ? (
                      <div style={{ fontSize: 13, color: '#9CA3AF' }}>Đang tải custom template…</div>
                    ) : customFormOptions.length === 0 ? (
                      <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#92400E' }}>
                        Chưa có custom template nào.
                      </div>
                    ) : (
                      <>
                        <select
                          value={directTemplateKey.startsWith('custom:') ? directTemplateKey.slice('custom:'.length) : ''}
                          onChange={e => handleTemplateKeyChange(templateStoreKeyFor('custom', Number(e.target.value)))}
                          style={{ width: '100%', padding: '10px 14px', borderRadius: 10, border: '1.5px solid #E5E7EB', fontSize: 14, fontFamily: 'inherit', outline: 'none', background: '#fff' }}
                        >
                          <option value="" disabled>— Chọn custom template —</option>
                          {customFormOptions.map(f => (
                            <option key={f.id} value={f.id}>
                              {f.name}{f.area_count > 0 ? ` — ${f.area_count} vùng OMR` : ''}
                            </option>
                          ))}
                        </select>
                        {directSchemaLoading && (
                          <span style={{ fontSize: 12.5, color: '#6B7280', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                            Đang tải schema…
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}

                <div style={{ marginTop: 14, fontSize: 12, color: '#9CA3AF' }}>
                  Mỗi mẫu có đáp án riêng — đổi mẫu không mất đáp án của mẫu khác. "Lưu Answer Key" sẽ dùng đáp án của mẫu đang chọn để chấm.
                </div>
              </div>

              <div style={{ flex: '1 1 320px', minWidth: 260, maxWidth: 460 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Xem trước mẫu đang chọn</div>
                <TemplatePreviewThumb
                  loading={directTemplateKey !== 'vju' && directSchemaLoading}
                  areas={directTemplateKey === 'vju' ? null : directAreas}
                  pageWidth={directPageW}
                  pageHeight={directPageH}
                  schema={directTemplateKey === 'vju' ? VJU_PRESET_SCHEMA : directSchema}
                  imageUrl={
                    directTemplateKey === 'vju'
                      ? (templateVariant === 'sbd4' ? VJU_SBD4_PREVIEW_IMAGE : VJU_SBD8_PREVIEW_IMAGE)
                      : PINNED_TEMPLATES.find(pt => templateStoreKeyFor('custom', pt.id) === directTemplateKey)?.previewImage ?? null
                  }
                  height={460}
                />
              </div>
            </div>
          </Card>
        )}

        {/* Custom template schema missing — error banner */}
        {isGradingMode && templateMode === 'custom' && !templateSchema && (
          <div style={{ background: '#FEF2F2', border: '1.5px solid #FCA5A5', borderRadius: 12, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <AlertTriangle size={20} color="#EF4444" style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#991B1B', marginBottom: 2 }}>
                Không tải được cấu trúc custom template
              </div>
              <div style={{ fontSize: 13, color: '#374151' }}>
                Schema của template <strong>{customTemplateName ?? `#${customTemplateId}`}</strong> chưa được tải.{' '}
                <button
                  onClick={() => navigate('/app/upload')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#C8102E', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, padding: 0 }}
                >
                  Quay lại Upload →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Grading mode banner */}
        {isGradingMode && (
          <div style={{ background: '#FFF5F5', border: '1.5px solid #C8102E', borderRadius: 12, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <Zap size={20} color="#C8102E" style={{ flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#C8102E', marginBottom: 2 }}>
                Chế độ chấm phiếu
              </div>
              <div style={{ fontSize: 13, color: '#374151' }}>
                {examName && <span>Kỳ thi: <strong>{examName}</strong> · </span>}
                Template:{' '}
                <strong>
                  {templateMode === 'custom' && customTemplateName
                    ? customTemplateName
                    : TEMPLATE_VARIANT_LABEL[templateVariant]}
                </strong>
                {' · '}Xác nhận hoặc chỉnh sửa đáp án bên dưới, rồi bấm{' '}
                <strong>"Lưu &amp; Bắt đầu chấm"</strong> để gửi {gradingFiles.length} phiếu lên chấm.
              </div>
            </div>
            {grading && (
              <div style={{ fontSize: 13, fontWeight: 700, color: '#C8102E', minWidth: 80, textAlign: 'right' }}>
                {doneCount}/{gradingFiles.length}
              </div>
            )}
          </div>
        )}

        {/* Grading error */}
        {gradingError && (
          <div style={{ background: '#FEF2F2', border: '1.5px solid #FECACA', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#991B1B' }}>
            {gradingError}
          </div>
        )}

        {/* Answers auto-filled from the kỳ thi's bộ đề trộn — read only */}
        {paperKey && (
          <div style={{ background: '#F0FDF4', border: '1.5px solid #86EFAC', borderRadius: 12, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <CheckCircle2 size={20} color="#15803D" style={{ flexShrink: 0 }} />
            <div style={{ flex: '1 1 300px', fontSize: 13, color: '#374151', lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#15803D', marginBottom: 2 }}>
                Đáp án tự động từ bộ đề trộn: {paperKey.versions.length} mã đề ({paperKey.versions.join(', ')})
              </div>
              Lấy từ bộ đề <strong>{paperKey.papers.join(', ')}</strong> đã gắn vào kỳ thi này. Hệ thống tự đọc mã đề trên từng phiếu
              để chấm đúng bộ đáp án. Phiếu có mã đề không thuộc bộ đề sẽ không bị chấm nhầm theo đề khác: phiếu đó báo
              "Chưa có đáp án đề …" và nằm ở <strong>Cần review</strong> để sửa mã đề. Muốn chấm đợt này bằng đáp án khác,
              bấm <strong>Dùng đáp án khác</strong>.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={leavePaperKey} disabled={grading}>Dùng đáp án khác</Button>
              <Button size="sm" variant="secondary" onClick={() => navigate('/app/exam-papers')}>Mở Trộn đề</Button>
            </div>
          </div>
        )}
        {!paperKey && paperFetched && (
          <div style={{ background: '#FFFBEB', border: '1.5px solid #FDE68A', borderRadius: 12, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <AlertTriangle size={20} color="#B45309" style={{ flexShrink: 0 }} />
            <div style={{ flex: '1 1 300px', fontSize: 13, color: '#374151', lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#B45309', marginBottom: 2 }}>
                Lần chấm này không dùng đáp án tự động của bộ đề
              </div>
              Đáp án bên dưới sửa được (nhập tay, Thư viện đáp án, Import Excel). Bộ đề <strong>{paperFetched.papers.join(', ')}</strong> ở
              trang Trộn đề không bị thay đổi.
            </div>
            <Button size="sm" variant="secondary" icon={<CheckCircle2 size={14} />} disabled={grading}
              onClick={() => { if (confirm('Dùng lại đáp án tự động của bộ đề? Những gì đã sửa trên màn hình sẽ bị thay bằng đáp án bộ đề.')) applyPaperKey(paperFetched); }}>
              Dùng lại đáp án bộ đề
            </Button>
          </div>
        )}

        {/* Chia đáp án theo mã đề */}
        {canSplitByMaDe && (
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: multiMaDe ? 12 : 0 }}>
              <Layers size={16} color="#C8102E" style={{ flexShrink: 0 }} />
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#374151', flex: 1 }}>Chia đáp án theo mã đề</h3>
              {paperLocked ? null : !multiMaDe ? (
                <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={startSplitByMaDe} disabled={grading}>
                  Bật chia theo mã đề
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={stopSplitByMaDe} disabled={grading} style={{ color: '#EF4444', borderColor: '#FECACA' }}>
                  Tắt chia theo mã đề
                </Button>
              )}
            </div>
            {!multiMaDe ? (
              <p style={{ margin: '8px 0 0', fontSize: 12, color: '#9CA3AF' }}>
                Dùng khi phiếu có nhiều mã đề khác nhau (VD: đề 101, 102, 103) và mỗi đề có đáp án đúng khác nhau.
                Khi chấm, hệ thống sẽ tự đọc mã đề trên từng phiếu để so với đúng bộ đáp án.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {maDeCodes.map(code => {
                    const isActive = code === activeMaDe;
                    const codeFilled = activeLabels.filter(l => (answersByMaDe[code]?.[l])).length;
                    return (
                      <div key={code} style={{ display: 'flex', alignItems: 'center' }}>
                        <button
                          onClick={() => setActiveMaDe(code)}
                          disabled={grading}
                          style={{
                            padding: '7px 14px', borderRadius: '8px 0 0 8px',
                            border: `1.5px solid ${isActive ? '#C8102E' : '#E5E7EB'}`,
                            background: isActive ? '#C8102E' : '#fff',
                            color: isActive ? '#fff' : '#374151',
                            fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          Đề {code} <span style={{ fontWeight: 500, opacity: 0.8 }}>({codeFilled}/{activeLabels.length})</span>
                        </button>
                        {maDeCodes.length > 1 && !paperLocked && (
                          <button
                            onClick={() => removeMaDeTab(code)}
                            disabled={grading}
                            title={`Xóa đề ${code}`}
                            style={{
                              padding: '7px 8px', borderRadius: '0 8px 8px 0',
                              border: `1.5px solid ${isActive ? '#C8102E' : '#E5E7EB'}`, borderLeft: 'none',
                              background: isActive ? '#C8102E' : '#fff',
                              color: isActive ? '#fff' : '#9CA3AF',
                              cursor: 'pointer', display: 'flex', alignItems: 'center',
                            }}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {!paperLocked && <button
                    onClick={addMaDeTab}
                    disabled={grading}
                    style={{ padding: '7px 14px', borderRadius: 8, border: '1.5px dashed #E5E7EB', background: '#fff', color: '#6B7280', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <Plus size={13} /> Thêm đề
                  </button>}
                </div>
                {maDeCodes.length > 1 && !paperLocked && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Copy size={13} color="#9CA3AF" />
                    <span style={{ fontSize: 12, color: '#6B7280' }}>Sao chép đáp án từ đề khác vào đề {activeMaDe}:</span>
                    <select
                      value=""
                      onChange={e => { if (e.target.value) copyFromMaDe(e.target.value); e.target.value = ''; }}
                      disabled={grading}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'inherit' }}
                    >
                      <option value="">— chọn đề —</option>
                      {maDeCodes.filter(c => c !== activeMaDe).map(c => <option key={c} value={c}>Đề {c}</option>)}
                    </select>
                  </div>
                )}
                <p style={{ margin: 0, fontSize: 12, color: '#9CA3AF' }}>
                  {paperLocked
                    ? <>Đang xem đáp án <strong style={{ color: '#C8102E' }}>Đề {activeMaDe}</strong>. Bấm từng mã đề để kiểm tra.</>
                    : <>Đang nhập đáp án cho <strong style={{ color: '#C8102E' }}>Đề {activeMaDe}</strong>. Các nút "Điền nhanh" và bảng câu hỏi bên dưới áp dụng cho đề này.</>}
                </p>
              </div>
            )}
          </Card>
        )}

        {/* Ký tên giám thị & người chấm thi — 2026-07-31: simplified from
           free-text name fields to plain "có" checkboxes; verifying whether
           the box was actually signed is the automatic OMR check, not
           something typed here (see ProctorInfo comment in types/grading.ts). */}
        <Card>
          <h3 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: '#374151' }}>
            Giám thị &amp; người chấm thi{multiMaDe && <span style={{ color: '#C8102E' }}> — Đề {activeMaDe}</span>}
          </h3>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: '#9CA3AF' }}>
            Tích chọn nếu đề này có vai trò tương ứng.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {PROCTOR_FIELD_LABELS.map(({ key, label }) => (
              <label
                key={key}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  borderRadius: 8, border: '1.5px solid #E5E7EB', fontSize: 13, fontWeight: 600,
                  color: currentProctors[key] ? '#374151' : '#9CA3AF', cursor: grading ? 'default' : 'pointer',
                  background: currentProctors[key] ? '#FEF2F2' : '#fff',
                }}
              >
                <input
                  type="checkbox"
                  checked={!!currentProctors[key]}
                  onChange={e => setProctorField(key, e.target.checked)}
                  disabled={grading}
                  style={{ accentColor: '#C8102E', width: 16, height: 16 }}
                />
                Có {label.toLowerCase()}
              </label>
            ))}
          </div>
        </Card>

        {/* Quick-fill — hidden when answers come from a bộ đề trộn */}
        {!paperLocked && <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#374151' }}>
            Điền nhanh{multiMaDe && <span style={{ color: '#C8102E' }}> — Đề {activeMaDe}</span>}
          </h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['A','B','C','D'] as const).map(ch => (
              <button key={ch}
                onClick={() => {
                  const fill = Object.fromEntries(abcdLabels.map(l => [l, ch]));
                  if (multiMaDe) setAnswersByMaDe(prev => ({ ...prev, [activeMaDe]: { ...(prev[activeMaDe] ?? {}), ...fill } }));
                  else setAnswers(prev => ({ ...prev, ...fill }));
                }}
                disabled={grading}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1.5px solid #E5E7EB', background: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Tất cả {ch}
              </button>
            ))}
            <button
              onClick={() => { if (multiMaDe) setAnswersByMaDe(prev => ({ ...prev, [activeMaDe]: {} })); else setAnswers({}); }}
              disabled={grading}
              style={{ padding: '6px 16px', borderRadius: 8, border: '1.5px solid #FECACA', background: '#FEF2F2', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: '#C8102E' }}
            >
              Xóa hết (chưa lưu)
            </button>
          </div>
        </Card>}

        {/* Status bar */}
        <div style={{ background: '#fff', borderRadius: 10, padding: '12px 16px', border: '1px solid #E5E7EB', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#6B7280' }}>Đã nhập:</span>
          <strong style={{ fontSize: 13, color: '#C8102E' }}>{filled}/{total} câu</strong>
          <div style={{ width: 140, height: 6, borderRadius: 3, background: '#E5E7EB', overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 3, background: '#C8102E', width: `${(filled / total) * 100}%`, transition: 'width 300ms' }} />
          </div>
          {savedAt ? (
            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#10B981', display: 'flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle2 size={13} />
              Đã lưu {new Date(savedAt).toLocaleString('vi-VN', { hour12: false })}
            </span>
          ) : (
            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#EF4444' }}>Chưa lưu</span>
          )}
        </div>

        {/* Sections — view-only when answers come from a bộ đề trộn */}
        <div style={paperLocked ? { pointerEvents: 'none', display: 'flex', flexDirection: 'column', gap: 20 } : { display: 'contents' }}>
        {activeSections.length === 0 && templateMode === 'custom' ? (
          <Card>
            <div style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', padding: '20px 0' }}>
              Template này không có câu trắc nghiệm — không cần nhập đáp án.
            </div>
          </Card>
        ) : (
          // 2026-07-30: "cái ak hiện tại hơi rối mắt" — the old per-question
          // control was a 38px-wide <select>, so you had to open a dropdown
          // just to see what was picked. Swapped for a row of big tappable
          // A/B/C/D (or Đúng/Sai) buttons — the chosen one is solid red, so
          // the whole answer key is readable at a glance without clicking
          // anything. Also flattened the old zone "box inside a box": the
          // zone (question-type grouping added 2026-07-29, still useful for
          // templates mixing MCQ + Đúng/Sai + tự luận) is now just a header
          // row with an overall progress readout, not another bordered card
          // wrapping the section cards.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {sectionZones.map(zone => {
              const zoneLabels = zone.sections.flatMap(s => s.labels);
              const zoneFilled = zoneLabels.filter(l => currentAnswers[l]).length;
              const zoneDone   = zoneFilled === zoneLabels.length && zoneLabels.length > 0;
              return (
                <div key={zone.key}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #F1F3F5' }}>
                    <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: '#1E1E1E' }}>{zone.label}</h3>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: zoneDone ? '#10B981' : '#9CA3AF' }}>
                      Nhập: {zoneFilled}/{zoneLabels.length} câu · {zoneLabels.length ? Math.round(zoneFilled / zoneLabels.length * 100) : 0}%
                    </span>
                  </div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                    gap: 12,
                  }}>
                    {zone.sections.map(({ name: section, labels, inputType, options }) => {
                      const sectionFilled = labels.filter(l => currentAnswers[l]).length;
                      const sectionDone   = sectionFilled === labels.length;
                      const isText = inputType === 'text';
                      const choices = options && options.length > 0 ? options : CHOICES.slice(1);
                      const mandatoryMatch = section.match(/^(.*?)\s*\(Bắt buộc\)\s*$/);
                      const sectionTitle = mandatoryMatch ? mandatoryMatch[1] : section;
                      return (
                        <div key={section} style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: '12px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
                            <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 800, color: '#1E1E1E' }}><SectionTitleText title={sectionTitle} /></h4>
                            {mandatoryMatch && (
                              <span style={{ fontSize: 9.5, fontWeight: 800, color: '#C8102E', letterSpacing: '0.03em' }}>BẮT BUỘC</span>
                            )}
                            <span style={{ flex: 1 }} />
                            <span style={{ fontSize: 12, fontWeight: 700, color: sectionDone ? '#10B981' : '#9CA3AF' }}>{sectionFilled}/{labels.length}</span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                            {labels.map((lbl, idx) => {
                              const val = currentAnswers[lbl] || '';
                              const customPt = scoring.questionPoints?.[lbl];
                              const isSelected = selectedForPoints.has(lbl);
                              const pointBadge = customPt != null && (
                                <span style={{
                                  position: 'absolute', top: -6, right: -6, minWidth: 15, height: 15, borderRadius: 8,
                                  background: '#C8102E', color: '#fff', fontSize: 8.5, fontWeight: 800,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px', lineHeight: 1, zIndex: 1,
                                }}>
                                  {customPt}
                                </span>
                              );
                              // In "chọn câu để đặt điểm" mode the row becomes a
                              // plain checkbox-like toggle — answer editing is
                              // paused so clicks can't accidentally change an
                              // answer while selecting a group of questions to
                              // price differently.
                              if (pointSelectMode) {
                                return (
                                  <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
                                    <span style={{ fontSize: 11.5, fontWeight: 700, color: '#9CA3AF', width: 16, textAlign: 'right', flexShrink: 0 }}>{idx + 1}</span>
                                    {pointBadge}
                                    <button
                                      type="button"
                                      onClick={() => toggleLabelSelectedForPoints(lbl)}
                                      style={{
                                        flex: 1, height: 30, borderRadius: 7,
                                        border: `1.5px solid ${isSelected ? '#C8102E' : '#D1D5DB'}`,
                                        background: isSelected ? '#FEF2F2' : '#fff',
                                        color: isSelected ? '#C8102E' : '#9CA3AF',
                                        fontSize: 12, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
                                      }}
                                    >
                                      {isSelected ? '✓ đã chọn' : 'chọn'}
                                    </button>
                                  </div>
                                );
                              }
                              if (isText) {
                                return (
                                  <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
                                    <span style={{ fontSize: 11.5, fontWeight: 700, color: '#9CA3AF', width: 16, textAlign: 'right', flexShrink: 0 }}>{idx + 1}</span>
                                    {pointBadge}
                                    <input
                                      type="text"
                                      value={val}
                                      onChange={e => setAnswer(lbl, e.target.value)}
                                      disabled={grading}
                                      placeholder="-12.34"
                                      style={{
                                        flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 7,
                                        border: `1.5px solid ${val ? '#D1D5DB' : '#F3B4BC'}`,
                                        fontSize: 13, fontWeight: 700,
                                        color:      val ? '#1F2937' : '#C8102E',
                                        background: val ? '#F9FAFB' : '#fff',
                                        fontFamily: 'monospace', cursor: grading ? 'not-allowed' : 'text', outline: 'none',
                                        textAlign: 'center',
                                      }}
                                    />
                                  </div>
                                );
                              }
                              return (
                                <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
                                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#9CA3AF', width: 16, textAlign: 'right', flexShrink: 0 }}>{idx + 1}</span>
                                  {pointBadge}
                                  <div style={{ display: 'flex', gap: 5 }}>
                                    {choices.map(c => {
                                      const chosen = val === c;
                                      return (
                                        <button
                                          key={c}
                                          type="button"
                                          disabled={grading}
                                          onClick={() => setAnswer(lbl, chosen ? '' : c)}
                                          title={chosen ? `Bấm lại để xoá đáp án câu ${idx + 1}` : undefined}
                                          style={{
                                            width: choices.length > 4 ? 26 : 30, height: 30, borderRadius: 7, padding: 0, flexShrink: 0,
                                            border: `1.5px solid ${chosen ? '#C8102E' : '#E5E7EB'}`,
                                            background: chosen ? '#C8102E' : '#fff',
                                            color: chosen ? '#fff' : '#9CA3AF',
                                            fontSize: 12.5, fontWeight: 800, cursor: grading ? 'not-allowed' : 'pointer',
                                            fontFamily: 'inherit',
                                          }}
                                        >
                                          {c}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>

        {/* Scoring config */}
        <Card>
          <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 700, color: '#374151' }}>Thang điểm</h3>
          {/* minmax(0, 1fr): plain 1fr columns can't shrink below the inputs' own width, so on a phone the 3 boxes ran off-screen */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
            {([
              { key: 'correct' as const, label: 'Đúng (+)',  color: '#065F46', bg: '#D1FAE5' },
              { key: 'wrong'   as const, label: 'Sai (±)',   color: '#991B1B', bg: '#FEE2E2' },
              { key: 'blank'   as const, label: 'Bỏ trống', color: '#6B7280', bg: '#F3F4F6' },
            ]).map(f => (
              <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{f.label}</label>
                <input
                  type="number" step="0.05" value={scoring[f.key]}
                  onChange={e => setScoringField(f.key, e.target.value)}
                  disabled={grading}
                  style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '9px 12px', borderRadius: 9, border: `1.5px solid ${f.bg}`, fontSize: 15, fontWeight: 700, color: f.color, background: f.bg, fontFamily: 'inherit', outline: 'none', textAlign: 'center' }}
                />
              </div>
            ))}
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 12, color: '#9CA3AF' }}>
            Điểm = Số đúng × {scoring.correct} + Số sai × ({scoring.wrong}) + Số trống × {scoring.blank}
            {overrideCount > 0 && <> — trừ {overrideCount} câu đã đặt điểm riêng (xem nhãn đỏ trên từng câu).</>}
          </p>

          {/* Điểm riêng theo nhóm câu */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #F1F3F5' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Button
                size="sm"
                variant={pointSelectMode ? 'outline' : 'secondary'}
                onClick={() => { setPointSelectMode(v => !v); setSelectedForPoints(new Set()); }}
                disabled={grading}
              >
                {pointSelectMode ? 'Xong — thoát chế độ chọn' : 'Chọn câu để đặt điểm riêng'}
              </Button>
              {overrideCount > 0 && (
                <Button size="sm" variant="secondary" onClick={clearAllPointOverrides} disabled={grading} style={{ color: '#EF4444', borderColor: '#FECACA' }}>
                  Bỏ hết điểm riêng ({overrideCount})
                </Button>
              )}
            </div>

            {pointSelectMode && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: '#FEF2F2', border: '1px solid #F3B4BC', borderRadius: 10, padding: '10px 14px' }}>
                <span style={{ fontSize: 13, color: '#991B1B' }}>
                  Đã chọn <strong>{selectedForPoints.size}</strong> câu — bấm vào từng ô số thứ tự bên trên để chọn/bỏ chọn.
                </span>
                <div style={{ flex: 1 }} />
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>Điểm cho các câu đã chọn:</label>
                <input
                  type="number" step="0.05" value={bulkPointValue}
                  onChange={e => setBulkPointValue(e.target.value)}
                  style={{ width: 70, padding: '6px 10px', borderRadius: 8, border: '1.5px solid #F3B4BC', fontSize: 13, fontWeight: 700, textAlign: 'center', fontFamily: 'inherit', outline: 'none' }}
                />
                <Button size="sm" variant="primary" onClick={applyBulkPoints} disabled={selectedForPoints.size === 0}>Áp dụng</Button>
                {selectedForPoints.size > 0 && (
                  <Button size="sm" variant="secondary" onClick={clearSelectedPointOverrides}>Bỏ điểm riêng của câu đã chọn</Button>
                )}
              </div>
            )}
          </div>
        </Card>

        {/* 2026-10-05: on a phone the page is ~7 screens long and "Lưu & Bắt
           đầu chấm" was only at the very bottom — keep it in a bar pinned above
           the bottom tab bar while grading (hidden on wider screens, see
           .ak-sticky-bar in globals.css). */}
        {isGradingMode && (
          <>
            <div className="ak-sticky-bar">
              <span style={{ fontSize: 12, color: '#6B7280', minWidth: 0 }}>
                {multiMaDe && activeMaDe ? <>Đề <b style={{ color: '#C8102E' }}>{activeMaDe}</b> · </> : null}
                <b style={{ color: '#1E1E1E' }}>{filled}/{total}</b> câu
              </span>
              {primaryButton}
            </div>
            <div className="ak-sticky-spacer" />
          </>
        )}

        {/* Bottom actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, flexWrap: 'wrap' }}>
          {primaryButton}
          <div style={{ width: 1, height: 28, background: '#E5E7EB', margin: '0 2px' }} />

          {/* Excel — primary format for giáo viên (không cần biết JSON) */}
          <Button size="sm" variant="outline" icon={<FileSpreadsheet size={14} />} onClick={handleExportExcel}>Xuất Excel</Button>
          <Button size="sm" variant="outline" icon={<Upload size={14} />} disabled={paperLocked} onClick={() => excelInputRef.current?.click()}>Import Excel</Button>
          <Button size="sm" variant="secondary" icon={<FileSpreadsheet size={14} />} onClick={handleSampleExcelDownload}>Tải mẫu Excel</Button>
          <input ref={excelInputRef} type="file" accept=".xlsx" multiple style={{ display: 'none' }} onChange={handleImportExcelFile} />

          <div style={{ width: 1, height: 28, background: '#E5E7EB', margin: '0 2px' }} />
          <Button size="sm" variant="secondary" icon={<BookmarkPlus size={14} />} onClick={handleSaveToLibrary}>Lưu vào thư viện</Button>

          <div style={{ flex: 1 }} />
          <Button size="sm" variant="secondary" icon={<Trash2 size={14} />} onClick={handleClear} disabled={paperLocked} style={{ color: '#EF4444', borderColor: '#FECACA' }}>Xóa Answer Key</Button>
        </div>

        {/* Preview modal — full detail of a saved library entry */}
        {previewEntry && (() => {
          const entry = previewEntry;
          const codes = entry.store.byMaDe ? Object.keys(entry.store.byMaDe) : [];
          const isMulti = codes.length > 0;
          // Read from the editable copies, not entry.store directly, so
          // in-popup edits ("có thể sửa được nữa") show live before saving.
          const shownAnswers = isMulti ? (previewAnswersByMaDe[previewMaDe] ?? {}) : previewAnswers;
          // Prefer the real template schema (proper section names, "Câu N" order)
          // so the popup reads the same as the actual editor. Falls back to a
          // guessed grouping only if the real schema couldn't be resolved
          // (e.g. that custom template was since deleted).
          const effectiveSchema = previewSchema ?? buildSchemaFromAnswerKeys(Object.keys(shownAnswers));
          const filledCount = Object.values(shownAnswers).filter(v => v && v.trim() !== '').length;
          return (
            <div
              onClick={closePreviewModal}
              style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24,
              }}
            >
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  background: '#fff', borderRadius: 16, width: '100%', maxWidth: 640, maxHeight: '85vh',
                  display: 'flex', flexDirection: 'column', overflow: 'hidden',
                  boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                }}
              >
                <div style={{ padding: '18px 22px', borderBottom: '1px solid #E5E7EB', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {entry.name}
                      <button onClick={handleRenamePreviewEntry} title="Đổi tên"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', padding: 2, display: 'flex' }}>
                        <Pencil size={13} />
                      </button>
                      {previewDirty && <span style={{ fontSize: 11.5, fontWeight: 600, color: '#C8102E' }}>· có thay đổi chưa lưu</span>}
                    </div>
                    <div style={{ fontSize: 12.5, color: '#9CA3AF', marginTop: 3 }}>
                      {entry.templateLabel} · Lưu lúc {new Date(entry.savedAt).toLocaleString('vi-VN', { hour12: false })}
                    </div>
                  </div>
                  <button onClick={closePreviewModal}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', padding: 4 }}>
                    <X size={18} />
                  </button>
                </div>

                {isMulti && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '12px 22px 0' }}>
                    {codes.map(code => (
                      <button key={code} onClick={() => setPreviewMaDe(code)}
                        style={{
                          padding: '5px 12px', borderRadius: 9999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                          border: `1.5px solid ${previewMaDe === code ? '#C8102E' : '#E5E7EB'}`,
                          background: previewMaDe === code ? '#C8102E' : '#fff',
                          color: previewMaDe === code ? '#fff' : '#374151',
                        }}
                      >
                        Đề {code}
                      </button>
                    ))}
                  </div>
                )}

                <div style={{ padding: '14px 22px', fontSize: 12.5, color: '#6B7280' }}>
                  {filledCount}/{Object.keys(shownAnswers).length} câu có đáp án
                  {' · '}Thang điểm: Đúng {entry.store.scoring.correct} · Sai {entry.store.scoring.wrong} · Trống {entry.store.scoring.blank}
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: '0 22px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {previewSchemaLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#9CA3AF', padding: '20px 0', justifyContent: 'center' }}>
                      <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Đang tải cấu trúc mẫu phiếu…
                    </div>
                  ) : effectiveSchema.answerSections.length === 0 ? (
                    <div style={{ fontSize: 13, color: '#9CA3AF', textAlign: 'center', padding: '20px 0' }}>Không có đáp án nào được lưu.</div>
                  ) : (
                    // Same "zones" grouping + compact/calm styling as the main
                    // editor screen — teachers said the old red-everywhere
                    // full-width layout was messy here too.
                    (() => {
                      const order: string[] = [];
                      const byKey = new Map<string, { key: string; label: string; sections: typeof effectiveSchema.answerSections }>();
                      for (const s of effectiveSchema.answerSections) {
                        const z = zoneForSection(s);
                        if (!byKey.has(z.key)) { byKey.set(z.key, { ...z, sections: [] }); order.push(z.key); }
                        byKey.get(z.key)!.sections.push(s);
                      }
                      return order.map(k => byKey.get(k)!);
                    })().map(zone => (
                      <div key={zone.key} style={{ background: '#FAFAFB', border: '1px solid #E5E7EB', borderRadius: 12, padding: 12 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 800, color: '#374151', marginBottom: 8 }}>
                          {zone.label}
                          <span style={{ fontWeight: 500, color: '#9CA3AF', marginLeft: 8, fontSize: 11 }}>
                            ({zone.sections.reduce((n, s) => n + s.labels.length, 0)} câu)
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                          {zone.sections.map(section => {
                            const isText = section.inputType === 'text';
                            const choices = ['—', ...(section.options && section.options.length > 0 ? section.options : ['A', 'B', 'C', 'D'])];
                            return (
                            <div key={section.name} style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 10px' }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#C8102E', marginBottom: 6 }}><SectionTitleText title={section.name} /></div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                {section.labels.map((lbl, idx) => {
                                  const val = shownAnswers[lbl] || '';
                                  const filled = !!val;
                                  const cellStyle: React.CSSProperties = {
                                    padding: isText ? '2px 4px' : '2px 0', borderRadius: 6,
                                    border: `1.2px solid ${filled ? '#D1D5DB' : '#F3B4BC'}`,
                                    fontSize: 11, fontWeight: 700, fontFamily: isText ? 'monospace' : 'inherit',
                                    color: filled ? '#1F2937' : '#C8102E',
                                    background: filled ? '#F9FAFB' : '#fff',
                                    outline: 'none', textAlign: 'center', cursor: 'pointer',
                                    width: isText ? 52 : 30,
                                  };
                                  return (
                                    <div key={lbl} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                                      <span style={{ fontSize: 8, color: '#9CA3AF' }}>{idx + 1}</span>
                                      {isText ? (
                                        <input type="text" value={val} placeholder="-12.34" style={cellStyle}
                                          onChange={e => setPreviewAnswer(lbl, e.target.value)} />
                                      ) : (
                                        <select value={val || '—'} style={cellStyle}
                                          onChange={e => setPreviewAnswer(lbl, e.target.value)}>
                                          {choices.map(c => <option key={c} value={c}>{c}</option>)}
                                        </select>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                            );
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div style={{ padding: '14px 22px', borderTop: '1px solid #E5E7EB', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="secondary" onClick={closePreviewModal}>Đóng</Button>
                  <Button size="sm" variant="outline" onClick={() => handleSavePreviewChanges()} disabled={!previewDirty}>
                    Lưu thay đổi
                  </Button>
                  <Button size="sm" onClick={handleUseInMainEditor}
                    style={{ background: '#C8102E', color: '#fff', borderColor: '#C8102E', fontWeight: 700 }}>
                    Nạp vào để dùng
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}

      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
