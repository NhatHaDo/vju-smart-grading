import { useState, useRef, useCallback } from 'react';
import PageHeader from '../components/layout/PageHeader';
import { Upload, Loader2, AlertTriangle, CheckCircle2, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { SECTION_MAP, type ImageSource, IMAGE_SOURCE_LABEL } from '../types/grading';

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

const API_BASE = 'http://localhost:8000/api/v1/omr/debug-grade';
const BACKEND_BASE = 'http://localhost:8000';

const SBD_VARIANTS = [
  { label: 'SBD 4 số', value: 'sbd4' },
  { label: 'SBD 8 số', value: 'sbd8' },
];

const IMAGE_SOURCES: { label: string; value: ImageSource }[] = [
  { label: 'Tự động', value: 'auto' },
  { label: 'Scan máy', value: 'flatbed' },
  { label: 'Scan app', value: 'scan_app' },
  { label: 'Camera', value: 'camera' },
];

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

function OverlayLink({ label, path }: { label: string; path: string | null }) {
  if (!path) return null;
  // Convert absolute server path → public URL
  // e.g. /abs/path/outputs/debug_overlays/xxx.jpg → /outputs/debug_overlays/xxx.jpg
  const match = path.match(/\/outputs\/.+/);
  const href = match ? `${BACKEND_BASE}${match[0]}` : null;

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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OmrDebugPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DebugGradeResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [templateVariant, setTemplateVariant] = useState<'sbd4' | 'sbd8'>('sbd8');
  const [imageSource, setImageSource] = useState<ImageSource>('auto');
  const inputRef = useRef<HTMLInputElement>(null);

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
      const url = `${API_BASE}?mean_mode=circle_mask&full_debug=true&template_variant=${templateVariant}&image_source=${imageSource}`;
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

      {/* Template variant selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Loại SBD:</span>
        {SBD_VARIANTS.map(v => (
          <label key={v.value} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: templateVariant === v.value ? 700 : 400, color: templateVariant === v.value ? '#C8102E' : '#374151' }}>
            <input
              type="radio"
              name="templateVariant"
              value={v.value}
              checked={templateVariant === v.value}
              onChange={() => setTemplateVariant(v.value as 'sbd4' | 'sbd8')}
              style={{ accentColor: '#C8102E' }}
            />
            {v.label}
          </label>
        ))}
      </div>

      {/* Image source selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Nguồn ảnh:</span>
        {IMAGE_SOURCES.map(s => (
          <label key={s.value} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: imageSource === s.value ? 700 : 400, color: imageSource === s.value ? '#C8102E' : '#374151' }}>
            <input
              type="radio"
              name="imageSource"
              value={s.value}
              checked={imageSource === s.value}
              onChange={() => setImageSource(s.value)}
              style={{ accentColor: '#C8102E' }}
            />
            {s.label}
          </label>
        ))}
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

              {/* Overlay links */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#374151' }}>Ảnh debug</div>
                <OverlayLink label="Aligned image"        path={result.debug.aligned_image_path} />
                <OverlayLink label="Overlay (tất cả)"     path={result.debug.overlay_all_path} />
                <OverlayLink label="Overlay (đã tô)"      path={result.debug.overlay_marked_only_path} />
                <OverlayLink label="Overlay (cảnh báo)"   path={result.debug.overlay_warnings_path} />
                <OverlayLink label="Means JSON"            path={result.debug.means_json_path} />
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
