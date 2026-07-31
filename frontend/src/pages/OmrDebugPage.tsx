import { useState, useRef, useCallback, useEffect } from 'react';
import PageHeader from '../components/layout/PageHeader';
import { Upload, Loader2, AlertTriangle, CheckCircle2, ExternalLink, ChevronDown, ChevronRight, LayoutTemplate, RefreshCw } from 'lucide-react';
import { SECTION_MAP, TEMPLATE_VARIANT_LABEL, PINNED_TEMPLATES, type ImageSource, type TemplateVariant } from '../types/grading';
import { customFormsApi, type CustomFormMeta } from '../services/apiClient';

// 2026-07-31: "bỏ cái nguồn ảnh đi (mặc định là tự động)" — mirrors the same
// removal already done on SheetReviewPage's Upload & Chấm page ("Nguồn ảnh"
// removed — teachers didn't know which option to pick). Debug-grade always
// auto-detects now; no picker needed.
const FIXED_IMAGE_SOURCE: ImageSource = 'auto';

// 2026-07-31: "phải có đủ như kia chứ" — this page only offered a bare
// "Loại SBD: SBD 4 số / SBD 8 số" toggle, while the real Upload & Chấm page
// (SheetReviewPage) has the full "Chọn mẫu phiếu" picker: VJU/Custom
// template tabs, plus the pinned "Mẫu 40 câu TN + Đúng/Sai" template. OMR
// Debug is meant to test grading exactly like the real upload flow, so it
// needs the same picker — otherwise you can't reproduce a bug that only
// happens on a custom/pinned template.
const SBD_TYPES: { label: string; variant: TemplateVariant }[] = [
  { label: 'SBD 4 số', variant: 'sbd4' },
  { label: 'SBD 8 số', variant: 'sbd8' },
];

// ── Types ──────────────────────────────────────────────────────────────────────

interface StudentInfo {
  cccd: string | null;
  sbd: string | null;
  ma_de: string | null;
  ca_thi: string | null;
  ma_ctdt: string | null;
  tu_chon: string | null;
}

interface Warning {
  field: string;
  type: 'multi_mark' | 'too_light' | 'needs_review';
  candidates: string[];
}

interface Score {
  total: number | null;
  max: number | null;
  correct: number | null;
  wrong: number | null;
  blank: number | null;
}

interface DebugInfo {
  threshold: number;
  mean_mode: string;
  prep_method: string;
  alignment_warnings: string[];
  aligned_image_path: string | null;
  overlay_all_path: string | null;
  overlay_marked_only_path: string | null;
  overlay_warnings_path: string | null;
  means_json_path: string | null;
  image_source: string | null;
  preprocess_strategy_used: string | null;
  alignment_info: string | null;
  marker_quality_score: number | null;
  warp_used: boolean | null;
  warp_rejected_reason: string | null;
}

interface DebugGradeResult {
  input: { filename: string; saved_as: string };
  student_info: StudentInfo;
  answers: Record<string, string | null>;
  warnings: Warning[];
  score: Score;
  debug: DebugInfo;
}

// ── Constants ──────────────────────────────────────────────────────────────────

// Same VITE_API_BASE convention as services/apiClient.ts — was hardcoded to
// localhost, which broke this page in production (see AnswerKeyPage.tsx for
// the full explanation of why this pattern matters).
const BACKEND_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000';
const API_BASE = `${BACKEND_BASE}/api/v1/omr/debug-grade`;

// Build reverse map: field label → section name
const LABEL_TO_SECTION: Record<string, string> = {};
for (const [section, labels] of Object.entries(SECTION_MAP)) {
  for (const lbl of labels) LABEL_TO_SECTION[lbl] = section;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid #f0f0f0' }}>
      <span style={{ width: 90, color: '#888', fontSize: 13, flexShrink: 0 }}>{label}</span>
      <span style={{ fontWeight: 600, fontSize: 13, color: value ? '#111' : '#bbb' }}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function AnswerCell({ label, value, hasWarning }: { label: string; value: string | null; hasWarning: boolean }) {
  const bg = hasWarning ? '#fff3cd' : value ? '#f0fdf4' : '#fafafa';
  const color = hasWarning ? '#856404' : value ? '#166534' : '#999';
  return (
    <div
      title={label}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        padding: '6px 4px',
        background: bg,
        borderRadius: 6,
        minWidth: 44,
      }}
    >
      <span style={{ fontSize: 10, color: '#999' }}>{label.replace(/^[a-z]+/, '')}</span>
      <span style={{ fontWeight: 700, fontSize: 15, color }}>{value ?? '?'}</span>
    </div>
  );
}

function SectionAnswers({
  section,
  labels,
  answers,
  warningFields,
}: {
  section: string;
  labels: string[];
  answers: Record<string, string | null>;
  warningFields: Set<string>;
}) {
  const [open, setOpen] = useState(true);
  const sectionLabels = labels.filter(l => l in answers);
  if (sectionLabels.length === 0) return null;

  const answered = sectionLabels.filter(l => answers[l]).length;
  const warned = sectionLabels.filter(l => warningFields.has(l)).length;

  return (
    <div style={{ marginBottom: 12, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          background: '#f9fafb',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
        }}
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{section}</span>
        <span style={{ fontSize: 12, color: '#666' }}>
          {answered}/{sectionLabels.length} trả lời
        </span>
        {warned > 0 && (
          <span style={{ fontSize: 12, color: '#b45309', display: 'flex', alignItems: 'center', gap: 3 }}>
            <AlertTriangle size={13} /> {warned} cảnh báo
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: '10px 14px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {sectionLabels.map(lbl => (
            <AnswerCell
              key={lbl}
              label={lbl}
              value={answers[lbl] ?? null}
              hasWarning={warningFields.has(lbl)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Convert a server-side path → public URL.
// 2026-07-31: "đâu ảnh detect đâu ?" — backend actually returns a RELATIVE
// path here (e.g. "outputs/debug_overlays/xxx.jpg", no leading slash), but
// this used to require a leading "/outputs/" to match — so it silently
// matched nothing and every image (and even the "Means JSON" link) failed
// to render, with no error shown. Find "outputs/" wherever it occurs
// instead, so both "/abs/path/outputs/..." and "outputs/..." work.
function overlayHref(path: string | null): string | null {
  if (!path) return null;
  const idx = path.indexOf('outputs/');
  if (idx === -1) return null;
  return `${BACKEND_BASE}/${path.slice(idx)}`;
}

function OverlayLink({ label, path }: { label: string; path: string | null }) {
  if (!path) return null;
  const href = overlayHref(path);
  return (
    <div style={{ marginBottom: 6 }}>
      <span style={{ fontSize: 12, color: '#666', width: 200, display: 'inline-block' }}>{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#2563eb', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          Xem ảnh <ExternalLink size={12} />
        </a>
      ) : (
        <span style={{ fontSize: 12, color: '#bbb' }}>{path}</span>
      )}
    </div>
  );
}

// 2026-07-31: "ko có ảnh detect thì sao mà nhìn đc" — the overlay images
// (bubbles the engine detected, marked/warned ones highlighted) used to be
// text links you had to click and open in a new tab to see anything at all.
// Now shown inline so you can actually look at the detection result on this
// page, click to open full-size only when you need to zoom in.
function OverlayImage({ label, path }: { label: string; path: string | null }) {
  const href = overlayHref(path);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ display: 'block', textDecoration: 'none' }}
      title="Bấm để xem ảnh gốc kích thước đầy đủ"
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
        {label} <ExternalLink size={11} color="#9ca3af" />
      </div>
      <img
        src={href}
        alt={label}
        style={{
          width: '100%', maxHeight: 480, objectFit: 'contain',
          border: '1px solid #e5e7eb', borderRadius: 8, background: '#fafafa',
        }}
      />
    </a>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OmrDebugPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DebugGradeResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Template mode: 'vju' | 'custom' — mirrors SheetReviewPage's picker ────
  const [templateMode, setTemplateMode] = useState<'vju' | 'custom'>('vju');
  const [selectedSbd, setSelectedSbd] = useState(1); // 0=sbd4, 1=sbd8
  const [selectedPinnedCustomId, setSelectedPinnedCustomId] = useState<number | null>(null);
  const [customForms, setCustomForms] = useState<CustomFormMeta[]>([]);
  const [customFormsLoading, setCustomFormsLoading] = useState(false);
  const [selectedCustomId, setSelectedCustomId] = useState<number | null>(null);

  const loadCustomForms = async () => {
    setCustomFormsLoading(true);
    try {
      const data = await customFormsApi.list();
      setCustomForms(data.forms as CustomFormMeta[]);
      setSelectedCustomId(prev => prev ?? data.forms[0]?.id ?? null);
    } catch { /* auth errors handled globally by apiClient */ }
    finally { setCustomFormsLoading(false); }
  };

  useEffect(() => { void loadCustomForms(); }, []);

  const templateVariant: TemplateVariant = SBD_TYPES[selectedSbd].variant;
  // A pinned template (picked from the "vju" tab) grades through the same
  // custom-template path as the "custom" tab — same distinction as
  // SheetReviewPage.
  const effectiveTemplateMode: 'vju' | 'custom' =
    templateMode === 'custom' || selectedPinnedCustomId !== null ? 'custom' : 'vju';
  const effectiveCustomId: number | null =
    templateMode === 'custom' ? selectedCustomId : selectedPinnedCustomId;
  const selectedCustomForm = customForms.find(f => f.id === effectiveCustomId) ?? null;
  const pinnedTemplateLabel = PINNED_TEMPLATES.find(pt => pt.id === effectiveCustomId)?.label ?? null;
  const effectiveCustomName = selectedCustomForm?.name ?? pinnedTemplateLabel;

  const handleFile = useCallback((f: File) => {
    setFile(f);
    setResult(null);
    setError(null);
    const url = URL.createObjectURL(f);
    setPreview(url);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const onSubmit = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const fd = new FormData();
      fd.append('image', file);
      // Custom/pinned template → template_id (DB lookup, takes priority on
      // the backend); plain VJU sbd4/sbd8 → template_variant. Same priority
      // SheetReviewPage relies on for the real grading flow.
      const templateParam =
        effectiveTemplateMode === 'custom' && effectiveCustomId !== null
          ? `template_id=${effectiveCustomId}`
          : `template_variant=${templateVariant}`;
      const url = `${API_BASE}?mean_mode=circle_mask&full_debug=true&${templateParam}&image_source=${FIXED_IMAGE_SOURCE}`;
      const res = await fetch(url, { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) {
        setError(json.detail ?? `Lỗi ${res.status}`);
      } else {
        setResult(json as DebugGradeResult);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Lỗi kết nối đến backend');
    } finally {
      setLoading(false);
    }
  };

  const warningFields = new Set((result?.warnings ?? []).map(w => w.field));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader title="OMR Debug" subtitle="Upload ảnh phiếu trả lời → chấm thử trực tiếp, không cần kỳ thi." />
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '28px 24px', width: '100%', fontFamily: 'inherit' }}>

      {/* Upload zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? '#C8102E' : '#d1d5db'}`,
          borderRadius: 12,
          padding: '32px 24px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragging ? '#fff5f5' : '#fafafa',
          transition: 'all 150ms',
          marginBottom: 20,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/tiff,image/bmp,image/webp"
          style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        {preview ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <img
              src={preview}
              alt="preview"
              style={{ maxHeight: 200, maxWidth: '100%', borderRadius: 8, objectFit: 'contain', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}
            />
            <span style={{ fontSize: 13, color: '#555' }}>{file?.name}</span>
            <span style={{ fontSize: 12, color: '#aaa' }}>Click hoặc kéo thả để đổi ảnh</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: '#9ca3af' }}>
            <Upload size={36} />
            <span style={{ fontSize: 14 }}>Kéo thả ảnh phiếu vào đây, hoặc <span style={{ color: '#C8102E', fontWeight: 600 }}>click để chọn</span></span>
            <span style={{ fontSize: 12 }}>JPEG, PNG, TIFF, BMP, WebP</span>
          </div>
        )}
      </div>

      {/* Template picker — same "Chọn mẫu phiếu" section as Upload & Chấm,
         so a bug reproduced here (custom/pinned template incl.) matches what
         a teacher actually sees. */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#C8102E', marginBottom: 12 }}>Chọn mẫu phiếu</div>

        {/* Mode tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {([
            { value: 'vju', label: 'Mẫu phiếu VJU' },
            { value: 'custom', label: 'Custom template' },
          ] as const).map(opt => (
            <button
              key={opt.value}
              onClick={() => setTemplateMode(opt.value)}
              style={{
                padding: '7px 16px', borderRadius: 9999, fontSize: 13, fontWeight: 600,
                border: `1.5px solid ${templateMode === opt.value ? '#C8102E' : '#E5E7EB'}`,
                background: templateMode === opt.value ? '#FEF2F2' : '#fff',
                color: templateMode === opt.value ? '#C8102E' : '#374151',
                cursor: 'pointer', fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              {opt.value === 'custom' && <LayoutTemplate size={13} />}
              {opt.label}
            </button>
          ))}
        </div>

        {/* VJU mode — SBD types + pinned templates */}
        {templateMode === 'vju' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 600 }}>Loại SBD:</span>
              {SBD_TYPES.map((s, i) => (
                <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: selectedPinnedCustomId === null && i === selectedSbd ? 700 : 400, color: selectedPinnedCustomId === null && i === selectedSbd ? '#C8102E' : '#374151' }}>
                  <input
                    type="radio" name="sbd"
                    checked={selectedPinnedCustomId === null && i === selectedSbd}
                    onChange={() => { setSelectedSbd(i); setSelectedPinnedCustomId(null); }}
                    style={{ accentColor: '#C8102E' }}
                  />
                  {s.label}
                </label>
              ))}
              {PINNED_TEMPLATES.map(pt => (
                <label key={pt.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: selectedPinnedCustomId === pt.id ? 700 : 400, color: selectedPinnedCustomId === pt.id ? '#C8102E' : '#374151' }}>
                  <input
                    type="radio" name="sbd"
                    checked={selectedPinnedCustomId === pt.id}
                    onChange={() => setSelectedPinnedCustomId(pt.id)}
                    style={{ accentColor: '#C8102E' }}
                  />
                  {pt.label}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', background: '#F9FAFB', borderRadius: 8, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
              <CheckCircle2 size={13} color="#10B981" />
              <strong style={{ color: '#1E1E1E' }}>
                {selectedPinnedCustomId === null ? TEMPLATE_VARIANT_LABEL[templateVariant] : (effectiveCustomName ?? '…')}
              </strong>
            </div>
          </div>
        )}

        {/* Custom template mode */}
        {templateMode === 'custom' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {customFormsLoading ? (
              <div style={{ fontSize: 13, color: '#9CA3AF' }}>Đang tải custom template…</div>
            ) : customForms.length === 0 ? (
              <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#92400E' }}>
                Chưa có custom template nào.
              </div>
            ) : (
              <>
                <select
                  value={selectedCustomId ?? ''}
                  onChange={e => setSelectedCustomId(Number(e.target.value))}
                  style={{ width: '100%', padding: '10px 14px', borderRadius: 10, border: '1.5px solid #E5E7EB', fontSize: 14, fontFamily: 'inherit', outline: 'none', background: '#fff' }}
                >
                  {customForms.map(f => (
                    <option key={f.id} value={f.id}>
                      {f.name}{f.area_count > 0 ? ` — ${f.area_count} vùng OMR` : ''}
                    </option>
                  ))}
                </select>
                {selectedCustomForm && (
                  <div style={{ fontSize: 12, color: '#6B7280', background: '#F9FAFB', borderRadius: 8, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
                    <CheckCircle2 size={13} color="#10B981" />
                    Template: <strong style={{ color: '#1E1E1E' }}>{selectedCustomForm.name}</strong>
                    {selectedCustomForm.page_width && selectedCustomForm.page_height && (
                      <span style={{ color: '#9CA3AF' }}>· {selectedCustomForm.page_width}×{selectedCustomForm.page_height}</span>
                    )}
                  </div>
                )}
              </>
            )}
            <button
              onClick={() => loadCustomForms()}
              style={{ border: '1.5px solid #E5E7EB', borderRadius: 9999, padding: '4px 12px', fontSize: 11, fontWeight: 600, color: '#374151', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start' }}
            >
              <RefreshCw size={11} /> Làm mới
            </button>
          </div>
        )}
      </div>

      {/* Submit button */}
      <button
        onClick={onSubmit}
        disabled={!file || loading}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 24px',
          background: !file || loading ? '#e5e7eb' : '#C8102E',
          color: !file || loading ? '#9ca3af' : '#fff',
          border: 'none',
          borderRadius: 8,
          fontSize: 15,
          fontWeight: 600,
          cursor: !file || loading ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
          transition: 'background 150ms',
          marginBottom: 28,
        }}
      >
        {loading ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle2 size={18} />}
        {loading ? 'Đang chấm...' : 'Chấm thử'}
      </button>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Error */}
      {error && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
          padding: '14px 16px', color: '#b91c1c', fontSize: 14, marginBottom: 24,
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {/* Results */}
      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

          {/* Student info */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: '#111' }}>Thông tin thí sinh</h2>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px' }}>
              <InfoRow label="SBD"      value={result.student_info.sbd} />
              <InfoRow label="CCCD"     value={result.student_info.cccd} />
              <InfoRow label="Mã đề"    value={result.student_info.ma_de} />
              <InfoRow label="Ca thi"   value={result.student_info.ca_thi} />
              <InfoRow label="Mã CTĐT"  value={result.student_info.ma_ctdt} />
              <InfoRow label="Tự chọn"  value={result.student_info.tu_chon} />
            </div>
          </section>

          {/* Answers grouped by section */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: '#111' }}>
              Đáp án ({Object.values(result.answers).filter(Boolean).length}/{Object.keys(result.answers).length} đã trả lời)
            </h2>
            {Object.entries(SECTION_MAP).map(([section, labels]) => (
              <SectionAnswers
                key={section}
                section={section}
                labels={labels}
                answers={result.answers}
                warningFields={warningFields}
              />
            ))}
          </section>

          {/* Warnings */}
          {result.warnings.length > 0 && (
            <section>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: '#b45309' }}>
                <AlertTriangle size={18} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
                Cảnh báo ({result.warnings.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {result.warnings.map((w, i) => (
                  <div key={i} style={{
                    background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8,
                    padding: '10px 14px', fontSize: 13,
                  }}>
                    <span style={{ fontWeight: 600 }}>{w.field}</span>
                    {' — '}
                    <span style={{ color: '#78350f' }}>
                      {w.type === 'multi_mark' ? `Tô nhiều ô: ${w.candidates.join(', ')}` :
                       w.type === 'too_light'  ? `Tô quá nhạt` :
                                                 `Cần xem lại`}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Debug info */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: '#111' }}>Debug</h2>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 16 }}>
                <div style={{ textAlign: 'center', background: '#f9fafb', borderRadius: 8, padding: '10px 8px' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#111' }}>{result.debug.threshold}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>Threshold</div>
                </div>
                <div style={{ textAlign: 'center', background: '#f9fafb', borderRadius: 8, padding: '10px 8px' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{result.debug.mean_mode}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>Mean mode</div>
                </div>
                <div style={{ textAlign: 'center', background: '#f9fafb', borderRadius: 8, padding: '10px 8px' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{result.debug.prep_method}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>Prep method</div>
                </div>
                <div style={{ textAlign: 'center', background: result.debug.image_source === 'camera' ? '#FEF3C7' : '#f9fafb', borderRadius: 8, padding: '10px 8px' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{result.debug.image_source ?? '—'}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>Image source</div>
                </div>
                <div style={{ textAlign: 'center', background: '#f9fafb', borderRadius: 8, padding: '10px 8px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#111' }}>{result.debug.preprocess_strategy_used ?? '—'}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>Strategy</div>
                </div>
              </div>

              {/* Alignment & marker info */}
              {result.debug.alignment_info && (
                <div style={{ fontSize: 12, color: '#374151', marginBottom: 8, padding: '6px 10px', background: '#f0fdf4', borderRadius: 6, fontWeight: 500 }}>
                  {result.debug.alignment_info}
                </div>
              )}
              {result.debug.marker_quality_score != null && (
                <div style={{ fontSize: 12, marginBottom: 8, padding: '6px 10px', background: result.debug.warp_used ? '#f0fdf4' : '#fffbeb', borderRadius: 6 }}>
                  <strong>Marker quality:</strong> {(result.debug.marker_quality_score * 100).toFixed(0)}%
                  {' · '}
                  <strong>Warp:</strong> {result.debug.warp_used ? '✓ applied' : '✗ rejected'}
                  {result.debug.warp_rejected_reason && (
                    <span style={{ color: '#b45309' }}> — {result.debug.warp_rejected_reason}</span>
                  )}
                </div>
              )}

              {/* Overlay images — shown inline now, click any to open full-size */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: '#374151' }}>Ảnh debug</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 10 }}>
                  <OverlayImage label="Ảnh đã căn chỉnh (aligned)"  path={result.debug.aligned_image_path} />
                  <OverlayImage label="Overlay — tất cả ô đọc được" path={result.debug.overlay_all_path} />
                  <OverlayImage label="Overlay — chỉ ô đã tô"       path={result.debug.overlay_marked_only_path} />
                  <OverlayImage label="Overlay — ô có cảnh báo"     path={result.debug.overlay_warnings_path} />
                </div>
                <OverlayLink label="Means JSON" path={result.debug.means_json_path} />
              </div>

              {result.debug.alignment_warnings?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#374151' }}>Alignment warnings</div>
                  {result.debug.alignment_warnings.map((w, i) => (
                    <div key={i} style={{ fontSize: 12, color: '#6b7280', padding: '3px 0' }}>{w}</div>
                  ))}
                </div>
              )}
            </div>
          </section>

        </div>
      )}
      </div>
    </div>
  );
}
