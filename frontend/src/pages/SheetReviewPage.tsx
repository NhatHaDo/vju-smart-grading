import { useState, useRef, useEffect } from 'react';
import { FileImage, CheckCircle2, AlertTriangle, X, ArrowRight, RefreshCw, LayoutTemplate } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import PageHeader from '../components/layout/PageHeader';
import type { TemplateVariant, ImageSource } from '../types/grading';
import { TEMPLATE_VARIANT_LABEL } from '../types/grading';
import { examsApi, customFormsApi } from '../services/apiClient';
import type { CustomFormMeta } from '../services/apiClient';
import type { ExamOut } from '../types/exam';

const SBD_TYPES: { label: string; variant: TemplateVariant }[] = [
  { label: 'SBD 4 số', variant: 'sbd4' },
  { label: 'SBD 8 số', variant: 'sbd8' },
];

const SOURCES: { label: string; value: ImageSource }[] = [
  { label: 'Tự động phát hiện',                value: 'auto' },
  { label: 'Scan máy (flatbed)',                value: 'flatbed' },
  { label: 'Scan app (CamScanner, Adobe Scan...)', value: 'scan_app' },
  { label: 'Ảnh camera điện thoại',             value: 'camera' },
];

export default function SheetReviewPage() {
  const navigate = useNavigate();

  // ── Exam state ───────────────────────────────────────────────────────────
  const [exams,          setExams]          = useState<ExamOut[]>([]);
  const [examsLoading,   setExamsLoading]   = useState(true);
  const [examsError,     setExamsError]     = useState(false);
  const [selectedExamId, setSelectedExamId] = useState<number | null>(null);

  // ── Template mode: 'vju' | 'custom' ─────────────────────────────────────
  const [templateMode,   setTemplateMode]   = useState<'vju' | 'custom'>('vju');
  const [selectedSbd,    setSelectedSbd]    = useState(1); // 0=sbd4, 1=sbd8

  // ── Custom templates ─────────────────────────────────────────────────────
  const [customForms,        setCustomForms]        = useState<CustomFormMeta[]>([]);
  const [customFormsLoading, setCustomFormsLoading] = useState(false);
  const [selectedCustomId,   setSelectedCustomId]   = useState<number | null>(null);

  // ── Other ─────────────────────────────────────────────────────────────────
  const [selectedSource, setSelectedSource] = useState(0);
  const [files,          setFiles]          = useState<File[]>([]);
  const [dragging,       setDragging]       = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const templateVariant: TemplateVariant = SBD_TYPES[selectedSbd].variant;
  const imageSource: ImageSource = SOURCES[selectedSource].value;

  // ── Load exams from API ──────────────────────────────────────────────────
  const loadExams = async () => {
    setExamsLoading(true);
    setExamsError(false);
    try {
      const list = await examsApi.list();
      setExams(list);
      if (list.length > 0 && selectedExamId === null) {
        setSelectedExamId(list[0].id);
      }
    } catch {
      setExamsError(true);
    } finally {
      setExamsLoading(false);
    }
  };

  // ── Load custom templates from API ───────────────────────────────────────
  // preselectId: if non-null, select this id after load (from sessionStorage nav).
  const loadCustomForms = async (preselectId: number | null = null) => {
    setCustomFormsLoading(true);
    try {
      const data = await customFormsApi.list();
      setCustomForms(data.forms as CustomFormMeta[]);
      if (preselectId !== null) {
        const found = data.forms.some(f => f.id === preselectId);
        setSelectedCustomId(found ? preselectId : (data.forms[0]?.id ?? null));
      } else if (data.forms.length > 0) {
        setSelectedCustomId(prev => prev ?? data.forms[0].id);
      }
    } catch { /* auth errors handled globally by apiClient */ }
    finally { setCustomFormsLoading(false); }
  };

  useEffect(() => {
    void loadExams();
    // Read sessionStorage BEFORE calling loadCustomForms to avoid stale-closure overwrite
    let preselectId: number | null = null;
    try {
      const raw = sessionStorage.getItem('vju_selected_template');
      if (raw) {
        const id = JSON.parse(raw) as number;
        if (id) {
          preselectId = id;
          setTemplateMode('custom');
          sessionStorage.removeItem('vju_selected_template');
        }
      }
    } catch { /* ignore */ }
    void loadCustomForms(preselectId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFiles = (newFiles: FileList | null) => {
    if (!newFiles) return;
    setFiles(prev => [...prev, ...Array.from(newFiles)]);
  };

  const removeFile = (idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const selectedCustomForm = customForms.find(f => f.id === selectedCustomId) ?? null;

  /** Navigate to AnswerKeyPage carrying File objects + selected exam + template in location.state. */
  const handleGoToAnswerKey = () => {
    if (files.length === 0) return;
    const exam = exams.find(e => e.id === selectedExamId) ?? null;
    navigate('/app/answer-key', {
      state: {
        mode: 'before-grading',
        files,
        templateVariant,
        imageSource,
        examId:   exam?.id   ?? null,
        examName: exam?.name ?? null,
        // custom template fields
        templateMode,
        customTemplateId:   templateMode === 'custom' ? (selectedCustomForm?.id   ?? null) : null,
        customTemplateName: templateMode === 'custom' ? (selectedCustomForm?.name ?? null) : null,
      },
    });
  };

  const currentExam = exams.find(e => e.id === selectedExamId) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title="Upload & Chấm phiếu"
        subtitle="Chọn kỳ thi, upload ảnh phiếu rồi sang nhập đáp án để chấm"
      />

      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Select exam */}
        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#C8102E', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            Kỳ thi cần chấm
            {examsLoading && <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 400 }}>Đang tải…</span>}
          </div>

          {examsError && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#991B1B', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={13} />
              Không tải được danh sách kỳ thi.
              <button onClick={loadExams} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#C8102E', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>
                <RefreshCw size={12} /> Thử lại
              </button>
            </div>
          )}

          {!examsLoading && !examsError && exams.length === 0 && (
            <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#92400E', marginBottom: 10 }}>
              Chưa có kỳ thi nào.{' '}
              <button onClick={() => navigate('/app/exams')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#C8102E', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, padding: 0 }}>
                Tạo kỳ thi →
              </button>
            </div>
          )}

          {exams.length > 0 && (
            <select
              value={selectedExamId ?? ''}
              onChange={e => setSelectedExamId(Number(e.target.value))}
              style={{ width: '100%', padding: '10px 14px', borderRadius: 10, border: '1.5px solid #E5E7EB', fontSize: 14, fontFamily: 'inherit', outline: 'none', background: '#fff' }}
            >
              {exams.map(e => (
                <option key={e.id} value={e.id}>
                  {e.name}{e.subject ? ` · ${e.subject}` : ''}
                </option>
              ))}
            </select>
          )}

          <div style={{ marginTop: 10, fontSize: 13, color: '#6B7280', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => navigate('/app/exams')}
              style={{ border: '1.5px solid #C8102E', borderRadius: 9999, padding: '5px 14px', color: '#C8102E', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600 }}>
              Tạo / sửa kỳ thi
            </button>
            {currentExam && (
              <span>Đang chọn: <strong>{currentExam.name}</strong></span>
            )}
          </div>
        </Card>

        {/* Template mode selector */}
        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#C8102E', marginBottom: 12 }}>Chọn mẫu phiếu</div>

          {/* Mode tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {([
              { value: 'vju',    label: 'Mẫu phiếu VJU' },
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

          {/* VJU mode — SBD selector */}
          {templateMode === 'vju' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 600 }}>Loại SBD:</span>
              {SBD_TYPES.map((s, i) => (
                <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: i === selectedSbd ? 700 : 400, color: i === selectedSbd ? '#C8102E' : '#374151' }}>
                  <input type="radio" name="sbd" checked={i === selectedSbd} onChange={() => setSelectedSbd(i)} style={{ accentColor: '#C8102E' }} />
                  {s.label}
                </label>
              ))}
              <div style={{ marginLeft: 8, fontSize: 12, color: '#6B7280', background: '#F9FAFB', borderRadius: 8, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={13} color="#10B981" />
                <strong style={{ color: '#1E1E1E' }}>{TEMPLATE_VARIANT_LABEL[templateVariant]}</strong>
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
                  Chưa có custom template nào.{' '}
                  <button
                    onClick={() => navigate('/app/templates')}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#C8102E', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, padding: 0 }}
                  >
                    Vào Template phiếu để define →
                  </button>
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
                    <div style={{ fontSize: 12, color: '#6B7280', background: '#F9FAFB', borderRadius: 8, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <CheckCircle2 size={13} color="#10B981" />
                      Template: <strong style={{ color: '#1E1E1E' }}>{selectedCustomForm.name}</strong>
                      {selectedCustomForm.page_width && selectedCustomForm.page_height && (
                        <span style={{ color: '#9CA3AF' }}>· {selectedCustomForm.page_width}×{selectedCustomForm.page_height}</span>
                      )}
                    </div>
                  )}
                </>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => navigate('/app/templates')}
                  style={{ border: '1.5px solid #E5E7EB', borderRadius: 9999, padding: '4px 12px', fontSize: 11, fontWeight: 600, color: '#374151', background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  Quản lý template →
                </button>
                <button
                  onClick={loadCustomForms}
                  style={{ border: '1.5px solid #E5E7EB', borderRadius: 9999, padding: '4px 12px', fontSize: 11, fontWeight: 600, color: '#374151', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <RefreshCw size={11} /> Làm mới
                </button>
              </div>
            </div>
          )}
        </Card>

        {/* Source */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Nguồn ảnh:</span>
            {SOURCES.map((s, i) => (
              <label key={s.value} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
                <input type="radio" name="source" checked={i === selectedSource} onChange={() => setSelectedSource(i)} style={{ accentColor: '#C8102E' }} />
                {s.label}
              </label>
            ))}
          </div>
        </Card>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => fileRef.current?.click()}
          style={{
            border: `2px dashed ${dragging ? '#C8102E' : '#FECACA'}`,
            borderRadius: 14, padding: '48px 24px', textAlign: 'center', cursor: 'pointer',
            background: dragging ? '#FFF5F5' : '#FFF9F9',
            transition: 'border-color 140ms, background 140ms',
          }}
        >
          <input ref={fileRef} type="file" accept=".jpg,.jpeg,.png,.heic,.heif,.webp,.tif,.tiff,.bmp,.pdf" multiple style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
          <FileImage size={40} color={dragging ? '#C8102E' : '#FCA5A5'} style={{ margin: '0 auto 12px' }} />
          <p style={{ margin: '0 0 6px', fontWeight: 600, fontSize: 15, color: '#374151' }}>Kéo thả ảnh/PDF phiếu thi vào đây</p>
          <p style={{ margin: 0, fontSize: 13, color: '#9CA3AF' }}>Hỗ trợ JPG, PNG, HEIC/HEIF, WEBP, TIFF, BMP, PDF</p>
        </div>

        {/* File list */}
        {files.length > 0 && (
          <Card style={{ padding: '12px 16px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{files.length} file đã chọn</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {files.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, padding: '6px 8px', borderRadius: 8, background: '#F9FAFB' }}>
                  <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #E5E7EB', flexShrink: 0 }} />
                  <span style={{ flex: 1, color: '#374151', fontWeight: 500 }}>{f.name}</span>
                  <span style={{ color: '#9CA3AF', fontSize: 11 }}>{(f.size / 1024).toFixed(0)} KB</span>
                  <button onClick={e => { e.stopPropagation(); removeFile(i); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9CA3AF', padding: 2, display: 'flex', flexShrink: 0 }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* CTA */}
        {files.length > 0 && (
          <div style={{ background: '#FFF9F9', border: '1px solid #FECACA', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#1E1E1E', marginBottom: 4 }}>
                {files.length} phiếu sẵn sàng — bước tiếp theo: nhập đáp án
              </div>
              <div style={{ fontSize: 12, color: '#6B7280' }}>
                Template: <strong>{TEMPLATE_VARIANT_LABEL[templateVariant]}</strong>
                {currentExam ? <> · Kỳ thi: <strong>{currentExam.name}</strong></> : <span style={{ color: '#EF4444' }}> · Chưa chọn kỳ thi!</span>}
                {' '}· Bạn sẽ được chuyển sang trang Answer Key để xác nhận đáp án trước khi chấm.
              </div>
            </div>
            <Button
              size="lg"
              icon={<ArrowRight size={16} />}
              onClick={handleGoToAnswerKey}
              style={!selectedExamId ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
            >
              Chấm phiếu →
            </Button>
          </div>
        )}

        {files.length === 0 && (
          <div style={{ fontSize: 13, color: '#9CA3AF', textAlign: 'center', padding: '8px 0' }}>
            Chọn ít nhất 1 file để tiếp tục.
          </div>
        )}

      </div>
    </div>
  );
}
