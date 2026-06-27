import { useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { normalizeUploadFile } from '../utils/fileConversion';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import PageHeader from '../components/layout/PageHeader';
import { Download, Upload, Trash2, FileJson, Save, CheckCircle2, Loader2, ArrowLeft, Zap, AlertTriangle } from 'lucide-react';
import {
  VJU_PRESET_SCHEMA,
  type AnswerKeyStore,
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
} from '../types/grading';

const CHOICES = ['—', 'A', 'B', 'C', 'D'];
const API_BASE = 'http://localhost:8000/api/v1/omr/debug-grade';
const BATCH_LS_KEY = 'vju_last_batch_grade';

function loadTemplateSchemaFromStorage(): TemplateSchema | null {
  try {
    const raw = sessionStorage.getItem('vju_template_schema');
    if (!raw) return null;
    return JSON.parse(raw) as TemplateSchema;
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
      const fromStorage = loadTemplateSchemaFromStorage();
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

  const existing = loadAnswerKey();
  const [answers,   setAnswers]   = useState<Record<string, string>>(() => existing?.answers ?? {});
  const [scoring,   setScoring]   = useState<ScoringWeights>(() => existing?.scoring ?? { ...DEFAULT_SCORING });
  const [savedAt,   setSavedAt]   = useState<string | null>(existing?.updatedAt ?? null);
  const [saveFlash, setSaveFlash] = useState(false);

  // grading progress
  const [grading,   setGrading]   = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [gradingError, setGradingError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const setAnswer = (label: string, val: string) =>
    setAnswers(prev => ({ ...prev, [label]: val === '—' ? '' : val }));

  const setScoringField = (field: keyof ScoringWeights, val: string) => {
    const n = parseFloat(val);
    if (!isNaN(n)) setScoring(prev => ({ ...prev, [field]: n }));
  };

  const handleSave = () => {
    const store: AnswerKeyStore = { answers, scoring, updatedAt: new Date().toISOString() };
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
  };

  const handleExport = () => {
    const store: AnswerKeyStore = { answers, scoring, updatedAt: new Date().toISOString() };
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
        if (parsed.answers && typeof parsed.answers === 'object') {
          setAnswers(parsed.answers);
          if (parsed.scoring) setScoring(parsed.scoring);
        } else if (typeof parsed === 'object') {
          setAnswers(parsed as Record<string, string>);
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
    activeLabels.forEach((lbl, i) => { sample[lbl] = ['A', 'B', 'C', 'D'][i % 4]; });
    const store: AnswerKeyStore = { answers: sample, scoring: DEFAULT_SCORING, updatedAt: new Date().toISOString() };
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
    const store: AnswerKeyStore = { answers, scoring, updatedAt: new Date().toISOString() };
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

  const filled = activeLabels.filter(l => answers[l]).length;
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

        {/* Quick-fill */}
        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#374151' }}>Điền nhanh</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['A','B','C','D'] as const).map(ch => (
              <button key={ch}
                onClick={() => setAnswers(Object.fromEntries(activeLabels.map(l => [l, ch])))}
                disabled={grading}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1.5px solid #E5E7EB', background: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Tất cả {ch}
              </button>
            ))}
            <button
              onClick={() => setAnswers({})}
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
              Template này không có trường MCQ — không cần nhập đáp án.
            </div>
          </Card>
        ) : activeSections.map(({ name: section, labels }) => {
          const sectionFilled = labels.filter(l => answers[l]).length;
          return (
            <Card key={section}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#C8102E', flex: 1 }}>{section}</h3>
                <span style={{ fontSize: 12, color: '#6B7280' }}>{sectionFilled}/{labels.length} đã nhập</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {labels.map((lbl, idx) => {
                  const val = answers[lbl] || '';
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
                        {CHOICES.map(c => <option key={c} value={c}>{c}</option>)}
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
