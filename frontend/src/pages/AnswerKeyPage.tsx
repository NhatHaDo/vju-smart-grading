import { useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { normalizeUploadFile } from '../utils/fileConversion';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import PageHeader from '../components/layout/PageHeader';
import { Download, Upload, Trash2, FileJson, Save, CheckCircle2, Loader2, ArrowLeft, Zap, AlertTriangle, Layers, Plus, X, Copy } from 'lucide-react';
import {
  VJU_PRESET_SCHEMA,
  type AnswerKeyStore,
  type AnswerKeySet,
  type ScoringWeights,
  type TemplateVariant,
  type ImageSource,
  type BatchGradeState,
  type OmrGradeResult,
  type TemplateSchema,
  TEMPLATE_VARIANT_LABEL,
  DEFAULT_SCORING,
  loadAnswerKey,
  saveAnswerKey,
  clearAnswerKey,
  schemaHasMaDe,
  isMultiMaDe,
} from '../types/grading';

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

  // Resolve template schema:
  // 1. navState.templateSchema (passed from SheetReviewPage) — primary
  // 2. sessionStorage (set by TemplatePage.handleLoad) — fallback
  // 3. null for custom (never fall back to VJU!) — show error
  // 4. VJU_PRESET_SCHEMA for vju mode
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

  const existing = loadAnswerKey();
  const canSplitByMaDe = schemaHasMaDe(templateSchema);

  const [answers,   setAnswers]   = useState<Record<string, string>>(() => existing?.answers ?? {});
  const [scoring,   setScoring]   = useState<ScoringWeights>(() => existing?.scoring ?? { ...DEFAULT_SCORING });
  const [savedAt,   setSavedAt]   = useState<string | null>(existing?.updatedAt ?? null);
  const [saveFlash, setSaveFlash] = useState(false);

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

  // grading progress
  const [grading,   setGrading]   = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [gradingError, setGradingError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Answers currently being edited on screen — the active đề's set in multi-đề
  // mode, or the flat single-key set otherwise. Every read/write in the form
  // below goes through these two so the section-rendering JSX doesn't need to
  // know which mode it's in.
  const currentAnswers = multiMaDe ? (answersByMaDe[activeMaDe] ?? {}) : answers;

  const setAnswer = (label: string, val: string) => {
    const v = val === '—' ? '' : val;
    if (multiMaDe) {
      setAnswersByMaDe(prev => ({ ...prev, [activeMaDe]: { ...(prev[activeMaDe] ?? {}), [label]: v } }));
    } else {
      setAnswers(prev => ({ ...prev, [label]: v }));
    }
  };

  const setScoringField = (field: keyof ScoringWeights, val: string) => {
    const n = parseFloat(val);
    if (!isNaN(n)) setScoring(prev => ({ ...prev, [field]: n }));
  };

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
        byMaDe[code] = { answers: answersByMaDe[code] ?? {}, scoring, updatedAt: now };
      }
      return { answers, scoring, updatedAt: now, byMaDe };
    }
    return { answers, scoring, updatedAt: now };
  };

  // ── Mã đề tab management ─────────────────────────────────────────────────
  const startSplitByMaDe = () => {
    const code = (window.prompt('Nhập mã đề hiện tại (VD: 101) — đáp án đã nhập ở trên sẽ chuyển vào đề này:') ?? '').trim();
    if (!code) return;
    setAnswersByMaDe({ [code]: { ...answers } });
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
    setActiveMaDe(code);
  };

  const removeMaDeTab = (code: string) => {
    if (!confirm(`Xóa đáp án đề ${code}?`)) return;
    const remaining = maDeCodes.filter(c => c !== code);
    setMaDeCodes(remaining);
    setAnswersByMaDe(prev => { const next = { ...prev }; delete next[code]; return next; });
    if (activeMaDe === code) setActiveMaDe(remaining[0] ?? '');
    if (remaining.length === 0) setMultiMaDe(false);
  };

  const stopSplitByMaDe = () => {
    if (!confirm('Tắt chia theo mã đề? Đáp án của đề đang chọn sẽ giữ lại làm bộ đáp án chung, các đề khác sẽ bị xóa.')) return;
    setAnswers(answersByMaDe[activeMaDe] ?? {});
    setMultiMaDe(false);
    setMaDeCodes([]);
    setAnswersByMaDe({});
    setActiveMaDe('');
  };

  const copyFromMaDe = (fromCode: string) => {
    if (!fromCode || fromCode === activeMaDe) return;
    if (!confirm(`Ghi đè đáp án đề ${activeMaDe} bằng đáp án đề ${fromCode}?`)) return;
    setAnswersByMaDe(prev => ({ ...prev, [activeMaDe]: { ...(prev[fromCode] ?? {}) } }));
  };

  const handleSave = () => {
    const store = buildStore();
    saveAnswerKey(store);
    setSavedAt(store.updatedAt);
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 2000);
  };

  const handleClear = () => {
    if (!confirm('Xóa toàn bộ answer key?')) return;
    clearAnswerKey();
    setAnswers({});
    setScoring({ ...DEFAULT_SCORING });
    setSavedAt(null);
    setMultiMaDe(false);
    setMaDeCodes([]);
    setAnswersByMaDe({});
    setActiveMaDe('');
  };

  const handleExport = () => {
    const store = buildStore();
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'vju_answer_key.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        if (parsed.byMaDe && typeof parsed.byMaDe === 'object' && Object.keys(parsed.byMaDe).length > 0) {
          const codes = Object.keys(parsed.byMaDe);
          const rebuilt: Record<string, Record<string, string>> = {};
          for (const c of codes) rebuilt[c] = parsed.byMaDe[c]?.answers ?? {};
          setAnswersByMaDe(rebuilt);
          setMaDeCodes(codes);
          setActiveMaDe(codes[0]);
          setMultiMaDe(true);
          if (parsed.scoring) setScoring(parsed.scoring);
        } else if (parsed.answers && typeof parsed.answers === 'object') {
          if (multiMaDe) {
            setAnswersByMaDe(prev => ({ ...prev, [activeMaDe]: parsed.answers }));
          } else {
            setAnswers(parsed.answers);
          }
          if (parsed.scoring) setScoring(parsed.scoring);
        } else if (typeof parsed === 'object') {
          if (multiMaDe) {
            setAnswersByMaDe(prev => ({ ...prev, [activeMaDe]: parsed as Record<string, string> }));
          } else {
            setAnswers(parsed as Record<string, string>);
          }
        } else {
          alert('JSON không đúng format');
        }
      } catch { alert('File không phải JSON hợp lệ'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSampleDownload = () => {
    const sample: Record<string, string> = {};
    activeSections.forEach(s => {
      if (s.inputType === 'text') {
        s.labels.forEach(lbl => { sample[lbl] = '-12.34'; });
        return;
      }
      const choices = s.options && s.options.length > 0 ? s.options : ['A', 'B', 'C', 'D'];
      s.labels.forEach((lbl, i) => { sample[lbl] = choices[i % choices.length]; });
    });
    const store: AnswerKeyStore = { answers: sample, scoring: DEFAULT_SCORING, updatedAt: new Date().toISOString() }; // sample export is always the flat single-key shape, regardless of current mode
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'vju_answer_key_sample.json'; a.click();
    URL.revokeObjectURL(url);
  };

  /** Stub error row helper */
  const _errRow = (filename: string, msg: string): OmrGradeResult => ({
    input:        { filename, saved_as: '' },
    student_info: { cccd: null, sbd: null, ma_de: null, ca_thi: null, ma_ctdt: null, tu_chon: null },
    answers: {}, warnings: [],
    score:   { total: null, max: null, correct: null, wrong: null, blank: null },
    debug:   { threshold: 0, mean_mode: '', prep_method: '', alignment_warnings: [], aligned_image_path: null, overlay_all_path: null, overlay_marked_only_path: null, overlay_warnings_path: null, means_json_path: null, image_source: null, preprocess_strategy_used: null },
    _error:  msg,
  });

  /** Save answer key then call API for each file, navigate to /app/results */
  const handleGradeNow = async () => {
    if (gradingFiles.length === 0) return;

    // Save answer key first
    const store = buildStore();
    saveAnswerKey(store);
    setSavedAt(store.updatedAt);

    setGrading(true);
    setDoneCount(0);
    setGradingError(null);

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
          ? `${API_BASE}?mean_mode=circle_mask&full_debug=true&template_id=${customTemplateId}&image_source=${imageSource}`
          : `${API_BASE}?mean_mode=circle_mask&full_debug=true&template_variant=${templateVariant}&image_source=${imageSource}`;
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
          : 'Nhập đáp án đúng, import/export JSON và thiết lập thang điểm'}
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

        {/* Chia đáp án theo mã đề */}
        {canSplitByMaDe && (
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: multiMaDe ? 12 : 0 }}>
              <Layers size={16} color="#C8102E" style={{ flexShrink: 0 }} />
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#374151', flex: 1 }}>Chia đáp án theo mã đề</h3>
              {!multiMaDe ? (
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
                        {maDeCodes.length > 1 && (
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
                  <button
                    onClick={addMaDeTab}
                    disabled={grading}
                    style={{ padding: '7px 14px', borderRadius: 8, border: '1.5px dashed #E5E7EB', background: '#fff', color: '#6B7280', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <Plus size={13} /> Thêm đề
                  </button>
                </div>
                {maDeCodes.length > 1 && (
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
                  Đang nhập đáp án cho <strong style={{ color: '#C8102E' }}>Đề {activeMaDe}</strong> — các nút "Điền nhanh" và bảng câu hỏi bên dưới áp dụng cho đề này.
                </p>
              </div>
            )}
          </Card>
        )}

        {/* Quick-fill */}
        <Card>
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
        </Card>

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

        {/* Sections */}
        {activeSections.length === 0 && templateMode === 'custom' ? (
          <Card>
            <div style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', padding: '20px 0' }}>
              Template này không có câu trắc nghiệm — không cần nhập đáp án.
            </div>
          </Card>
        ) : activeSections.map(({ name: section, labels, inputType, options }) => {
          const sectionFilled = labels.filter(l => currentAnswers[l]).length;
          const isText = inputType === 'text';
          const choices = ['—', ...(options && options.length > 0 ? options : CHOICES.slice(1))];
          return (
            <Card key={section}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#C8102E', flex: 1 }}>{section}</h3>
                <span style={{ fontSize: 12, color: '#6B7280' }}>{sectionFilled}/{labels.length} đã nhập</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {labels.map((lbl, idx) => {
                  const val = currentAnswers[lbl] || '';
                  if (isText) {
                    return (
                      <div key={lbl} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                        <span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 500 }}>Câu {idx + 1}</span>
                        <input
                          type="text"
                          value={val}
                          onChange={e => setAnswer(lbl, e.target.value)}
                          disabled={grading}
                          placeholder="-12.34"
                          style={{
                            padding: '5px 8px', borderRadius: 8,
                            border: `1.5px solid ${val ? '#C8102E' : '#E5E7EB'}`,
                            fontSize: 13, fontWeight: 700,
                            color:      val ? '#C8102E' : '#9CA3AF',
                            background: val ? '#FEECEC' : '#fff',
                            fontFamily: 'monospace', cursor: grading ? 'not-allowed' : 'text', outline: 'none',
                            width: 84, textAlign: 'center',
                          }}
                        />
                      </div>
                    );
                  }
                  return (
                    <div key={lbl} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                      <span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 500 }}>Câu {idx + 1}</span>
                      <select
                        value={val || '—'}
                        onChange={e => setAnswer(lbl, e.target.value)}
                        disabled={grading}
                        style={{
                          padding: '5px 4px', borderRadius: 8,
                          border: `1.5px solid ${val ? '#C8102E' : '#E5E7EB'}`,
                          fontSize: 13, fontWeight: 700,
                          color:      val ? '#C8102E' : '#9CA3AF',
                          background: val ? '#FEECEC' : '#fff',
                          fontFamily: 'inherit', cursor: grading ? 'not-allowed' : 'pointer', outline: 'none',
                          width: 50, textAlign: 'center',
                        }}
                      >
                        {choices.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}

        {/* Scoring config */}
        <Card>
          <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 700, color: '#374151' }}>Thang điểm</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
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
                  style={{ padding: '9px 12px', borderRadius: 9, border: `1.5px solid ${f.bg}`, fontSize: 15, fontWeight: 700, color: f.color, background: f.bg, fontFamily: 'inherit', outline: 'none', textAlign: 'center' }}
                />
              </div>
            ))}
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 12, color: '#9CA3AF' }}>
            Điểm = Số đúng × {scoring.correct} + Số sai × ({scoring.wrong}) + Số trống × {scoring.blank}
          </p>
        </Card>

        {/* Bottom actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, flexWrap: 'wrap' }}>
          {primaryButton}
          <div style={{ width: 1, height: 28, background: '#E5E7EB', margin: '0 2px' }} />
          <Button size="sm" variant="secondary" icon={<FileJson size={14} />} onClick={handleSampleDownload}>Tải mẫu JSON</Button>
          <Button size="sm" variant="secondary" icon={<Download size={14} />} onClick={handleExport}>Xuất JSON</Button>
          <Button size="sm" variant="secondary" icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()}>Import JSON</Button>
          <input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleImportFile} />
          <div style={{ flex: 1 }} />
          <Button size="sm" variant="secondary" icon={<Trash2 size={14} />} onClick={handleClear} style={{ color: '#EF4444', borderColor: '#FECACA' }}>Xóa Answer Key</Button>
        </div>

      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
