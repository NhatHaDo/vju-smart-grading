/**
 * TemplatePage.tsx — Quản lý template phiếu
 *
 * Layout:
 *   Bên trái: danh sách template cards
 *   Bên phải: detail panel của template đang chọn
 *
 * Actions:
 *   Xem    → chọn template, hiện detail panel (KHÔNG navigate sang /upload)
 *   Sửa    → /app/template-coordinate?templateId=…
 *   Dùng để chấm → set sessionStorage + navigate /app/upload
 *   Đổi tên, Nhân bản, Export, Xóa → như cũ
 */
import { useState, useEffect, useRef } from 'react';
import { Pencil, Trash2, Copy, Download, RefreshCw, Plus, Eye, Play } from 'lucide-react';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Badge from '../components/common/Badge';
import PageHeader from '../components/layout/PageHeader';
import { useNavigate } from 'react-router-dom';
import { customFormsApi, ApiError } from '../services/apiClient';
import type { CustomFormMeta, CustomFormDetail } from '../services/apiClient';
import { buildSchemaFromDetail } from '../utils/templateSchema';

// ── Schematic preview SVG ─────────────────────────────────────────────────────

function TemplatePreviewSvg({ areaCount }: { areaCount: number }) {
  const rows = 6; const cols = 4;
  const filled = Math.min(areaCount * 2, rows * cols);
  return (
    <svg viewBox={`0 0 ${cols * 18 + 4} ${rows * 18 + 4}`} style={{ width: '100%', maxWidth: 100 }}>
      {Array.from({ length: rows }).flatMap((_, r) =>
        Array.from({ length: cols }).map((_, c) => {
          const idx = r * cols + c;
          return (
            <rect
              key={`${r}-${c}`}
              x={c * 18 + 2} y={r * 18 + 2} width={14} height={14} rx={2}
              fill={idx < filled ? '#FEECEC' : '#F3F4F6'}
              stroke={idx < filled ? '#C8102E' : '#E5E7EB'}
              strokeWidth={0.7}
            />
          );
        })
      )}
    </svg>
  );
}

// ── Inline rename input ────────────────────────────────────────────────────────

function RenameInput({
  value,
  onSave,
  onCancel,
}: {
  value: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <input
        ref={ref}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onSave(name);
          if (e.key === 'Escape') onCancel();
        }}
        style={{
          padding: '4px 8px', borderRadius: 6, border: '1.5px solid #C8102E',
          fontSize: 13, fontFamily: 'inherit', outline: 'none', flex: 1,
        }}
      />
      <button
        onClick={() => onSave(name)}
        style={{ padding: '4px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 700, border: '1.5px solid #C8102E', color: '#fff', background: '#C8102E', cursor: 'pointer', fontFamily: 'inherit' }}>
        Lưu
      </button>
      <button
        onClick={onCancel}
        style={{ padding: '4px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 700, border: '1.5px solid #E5E7EB', color: '#374151', background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
        Huỷ
      </button>
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function TemplateDetailPanel({
  detail,
  meta,
  onEdit,
  onUseForGrading,
  onExport,
  onDuplicate,
  onDelete,
  actionLoading,
}: {
  detail: CustomFormDetail;
  meta: CustomFormMeta;
  onEdit: () => void;
  onUseForGrading: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  actionLoading: boolean;
}) {
  const typeLabel = meta.is_default ? 'VJU Preset (mặc định)' : 'Custom template';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Title */}
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#1E1E1E', marginBottom: 4 }}>{detail.name}</div>
        <div style={{ fontSize: 12, color: '#6B7280' }}>
          {typeLabel} · {detail.page_width}×{detail.page_height} px
        </div>
        <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 2 }}>
          Cập nhật: {detail.updated_at.replace('T', ' ').slice(0, 16)}
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1, background: '#F9FAFB', borderRadius: 8, padding: '10px 12px', border: '1px solid #E5E7EB' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#C8102E' }}>{detail.areas.length}</div>
          <div style={{ fontSize: 11, color: '#6B7280' }}>Vùng OMR</div>
        </div>
        <div style={{ flex: 1, background: '#F9FAFB', borderRadius: 8, padding: '10px 12px', border: '1px solid #E5E7EB' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#1d4ed8' }}>{detail.infoFields.length}</div>
          <div style={{ fontSize: 11, color: '#6B7280' }}>Field thông tin</div>
        </div>
        <div style={{ flex: 1, background: '#F9FAFB', borderRadius: 8, padding: '10px 12px', border: '1px solid #E5E7EB' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#059669' }}>{detail.answerFields.filter(f => !f.composite).length}</div>
          <div style={{ fontSize: 11, color: '#6B7280' }}>Câu trả lời</div>
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={onUseForGrading}
          style={{ width: '100%', padding: '10px 0', borderRadius: 9, fontSize: 13, fontWeight: 700, border: 'none', background: '#C8102E', color: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Play size={13} /> Dùng để chấm
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={onEdit}
            style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1.5px solid #E5E7EB', color: '#374151', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
            <Pencil size={11} /> Sửa template
          </button>
          <button
            onClick={onDuplicate}
            disabled={actionLoading}
            style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1.5px solid #E5E7EB', color: '#374151', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
            <Copy size={11} /> Nhân bản
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={onExport}
            style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1.5px solid #E5E7EB', color: '#374151', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
            <Download size={11} /> Export JSON
          </button>
          {!meta.is_default && (
            <button
              onClick={onDelete}
              disabled={actionLoading}
              style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1.5px solid #FECACA', color: '#C8102E', background: '#FEF2F2', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <Trash2 size={11} /> Xóa
            </button>
          )}
        </div>
      </div>

      {/* Info fields */}
      {detail.infoFields.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            THÔNG TIN
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {detail.infoFields.map(f => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, background: '#F9FAFB', border: '1px solid #F3F4F6' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{f.displayName || f.key}</span>
                </div>
                <span style={{ fontSize: 10, color: '#9CA3AF', background: '#E5E7EB', padding: '1px 6px', borderRadius: 10 }}>
                  {f.fieldType === 'QTYPE_INT' ? 'Dạng số' : f.fieldType}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Answer fields */}
      {detail.answerFields.filter(f => !f.composite).length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            ĐÁP ÁN
          </div>
          {/* Group by blockName */}
          {(() => {
            const groups = new Map<string, { label: string; count: number }>();
            detail.answerFields.filter(f => !f.composite).forEach(f => {
              if (!groups.has(f.blockName)) {
                groups.set(f.blockName, { label: f.label || f.blockName, count: 0 });
              }
              groups.get(f.blockName)!.count++;
            });
            return Array.from(groups.entries()).map(([blockName, { label, count }]) => (
              <div key={blockName} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, background: '#F9FAFB', border: '1px solid #F3F4F6', marginBottom: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#C8102E', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{label}</span>
                </div>
                <span style={{ fontSize: 10, color: '#9CA3AF', background: '#FEECEC', color: '#C8102E', padding: '1px 6px', borderRadius: 10 }}>
                  {count} câu · A/B/C/D
                </span>
              </div>
            ));
          })()}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TemplatePage() {
  const [forms, setForms]           = useState<CustomFormMeta[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  // ── Detail panel state ─────────────────────────────────────────────────────
  const [selectedId, setSelectedId]         = useState<number | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<CustomFormDetail | null>(null);
  const [detailLoading, setDetailLoading]   = useState(false);

  const navigate = useNavigate();

  // ── Fetch list ─────────────────────────────────────────────────────────────
  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await customFormsApi.list();
      setForms(data.forms as CustomFormMeta[]);
    } catch (e: unknown) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return;
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // ── View (open detail panel) ───────────────────────────────────────────────
  async function handleView(id: number) {
    if (selectedId === id) return; // already selected
    setSelectedId(id);
    setSelectedDetail(null);
    setDetailLoading(true);
    try {
      const detail = await customFormsApi.get(id);
      setSelectedDetail(detail);
    } catch (e: unknown) {
      alert(`Không thể tải chi tiết: ${e instanceof ApiError ? e.message : String(e)}`);
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  // ── Use for grading (old Load behavior) ───────────────────────────────────
  async function handleUseForGrading(id: number) {
    try {
      // Reuse already-loaded detail if possible
      const detail = (selectedId === id && selectedDetail) ? selectedDetail : await customFormsApi.get(id);
      const schema = buildSchemaFromDetail(detail);
      sessionStorage.setItem('vju_selected_template', JSON.stringify(id));
      sessionStorage.setItem('vju_template_schema', JSON.stringify(schema));
      sessionStorage.setItem('vju_template_name', JSON.stringify(forms.find(f => f.id === id)?.name ?? ''));
    } catch {
      sessionStorage.removeItem('vju_template_schema');
    }
    navigate('/app/upload');
  }

  // ── Edit ──────────────────────────────────────────────────────────────────
  function handleEdit(id: number) {
    navigate(`/app/template-coordinate?templateId=${id}`);
  }

  // ── Rename ────────────────────────────────────────────────────────────────
  async function handleRename(id: number, name: string) {
    if (!name.trim()) return;
    setActionLoading(id);
    try {
      await customFormsApi.rename(id, name);
      setForms(prev => prev.map(f => f.id === id ? { ...f, name } : f));
      if (selectedId === id && selectedDetail) {
        setSelectedDetail(prev => prev ? { ...prev, name } : prev);
      }
    } catch (e: unknown) {
      alert(`Đổi tên thất bại: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setActionLoading(null);
      setRenamingId(null);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  async function handleDelete(id: number, name: string) {
    if (!window.confirm(`Xoá template "${name}"? Hành động này không thể hoàn tác.`)) return;
    setActionLoading(id);
    try {
      await customFormsApi.delete(id);
      setForms(prev => prev.filter(f => f.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
        setSelectedDetail(null);
      }
    } catch (e: unknown) {
      alert(`Xoá thất bại: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setActionLoading(null);
    }
  }

  // ── Duplicate ─────────────────────────────────────────────────────────────
  async function handleDuplicate(id: number) {
    setActionLoading(id);
    try {
      const newForm = await customFormsApi.duplicate(id) as CustomFormMeta;
      setForms(prev => [newForm, ...prev]);
    } catch (e: unknown) {
      alert(`Nhân bản thất bại: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setActionLoading(null);
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────
  async function handleExport(id: number, name: string) {
    try {
      const data = selectedId === id && selectedDetail ? selectedDetail : await customFormsApi.get(id);
      const blob = new Blob([JSON.stringify(data.areas, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `${name.replace(/\s+/g, '_')}_areas.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(`Export thất bại: ${e instanceof ApiError ? e.message : String(e)}`);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const btnStyle = (color?: string): React.CSSProperties => ({
    border: `1.5px solid ${color ?? '#E5E7EB'}`,
    borderRadius: 9999,
    padding: '3px 9px',
    fontSize: 11,
    fontWeight: 600,
    color: color ?? '#374151',
    background: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    gap: 3,
  });

  const selectedMeta = forms.find(f => f.id === selectedId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="Template phiếu"
        subtitle="Quản lý custom template đã define"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" icon={<RefreshCw size={13} />} variant="secondary" onClick={load}>
              Làm mới
            </Button>
            <Button size="sm" icon={<Plus size={13} />} onClick={() => navigate('/app/template-coordinate')}>
              Define phiếu mới
            </Button>
          </div>
        }
      />

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* ═══ LEFT: card list ═════════════════════════════════════════════ */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', borderRight: selectedId ? '1px solid #E5E7EB' : 'none', minWidth: 0 }}>

          {/* Error */}
          {error && (
            <Card style={{ padding: '12px 16px', background: '#FEF2F2', border: '1px solid #FECACA', marginBottom: 14 }}>
              <div style={{ fontSize: 13, color: '#C8102E' }}>⚠ {error}</div>
            </Card>
          )}

          {/* Loading */}
          {loading && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#9CA3AF', fontSize: 13 }}>
              Đang tải…
            </div>
          )}

          {/* Empty */}
          {!loading && !error && forms.length === 0 && (
            <Card style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: 14, color: '#6B7280', marginBottom: 12 }}>
                Chưa có custom template nào.
              </div>
              <Button size="sm" icon={<Plus size={13} />} onClick={() => navigate('/app/template-coordinate')}>
                Define phiếu đầu tiên
              </Button>
            </Card>
          )}

          {/* Template cards */}
          {!loading && forms.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {forms.map(f => {
                const isSelected = f.id === selectedId;
                const busy = actionLoading === f.id;
                return (
                  <div
                    key={f.id}
                    onClick={() => !renamingId && handleView(f.id)}
                    style={{
                      width: 220,
                      border: `2px solid ${isSelected ? '#C8102E' : '#E5E7EB'}`,
                      borderRadius: 12,
                      padding: '12px 14px',
                      background: isSelected ? '#FFF9F9' : '#fff',
                      cursor: 'pointer',
                      transition: 'border-color 150ms, box-shadow 150ms',
                      boxShadow: isSelected ? '0 0 0 3px rgba(200,16,46,0.10)' : undefined,
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {/* Header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {renamingId === f.id ? (
                          <RenameInput
                            value={f.name}
                            onSave={name => handleRename(f.id, name)}
                            onCancel={() => setRenamingId(null)}
                          />
                        ) : (
                          <div style={{ fontWeight: 700, fontSize: 12, color: '#1E1E1E', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.name}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 3, flexShrink: 0, marginLeft: 4 }}>
                        {f.is_default && <Badge color="green">Mặc định</Badge>}
                        {isSelected && <Badge color="red">Đang xem</Badge>}
                      </div>
                    </div>

                    {/* SVG preview */}
                    <div style={{ marginBottom: 8 }}>
                      <TemplatePreviewSvg areaCount={f.area_count} />
                    </div>

                    {/* Meta */}
                    <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 8, lineHeight: 1.7 }}>
                      <div>{f.area_count} vùng OMR</div>
                      {f.page_width && f.page_height && (
                        <div>{f.page_width} × {f.page_height}</div>
                      )}
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                      <button style={btnStyle(isSelected ? '#C8102E' : undefined)}
                        onClick={e => { e.stopPropagation(); handleView(f.id); }}>
                        <Eye size={10} /> {isSelected ? 'Đang xem' : 'Xem'}
                      </button>
                      <button style={btnStyle()} onClick={e => { e.stopPropagation(); handleEdit(f.id); }}>
                        <Pencil size={10} /> Sửa
                      </button>
                      <button style={{ ...btnStyle('#C8102E'), background: '#FEF2F2' }}
                        onClick={e => { e.stopPropagation(); handleUseForGrading(f.id); }}>
                        <Play size={10} /> Chấm
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {!f.is_default && renamingId !== f.id && (
                        <button style={btnStyle()} onClick={e => { e.stopPropagation(); setRenamingId(f.id); }}>
                          Đổi tên
                        </button>
                      )}
                      <button style={btnStyle()} onClick={e => { e.stopPropagation(); handleDuplicate(f.id); }} disabled={busy}>
                        <Copy size={10} /> Nhân bản
                      </button>
                      <button style={btnStyle()} onClick={e => { e.stopPropagation(); handleExport(f.id, f.name); }}>
                        <Download size={10} />
                      </button>
                      {!f.is_default && (
                        <button
                          style={{ ...btnStyle('#FECACA'), color: '#C8102E' }}
                          onClick={e => { e.stopPropagation(); handleDelete(f.id, f.name); }}
                          disabled={busy}>
                          <Trash2 size={10} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ═══ RIGHT: detail panel ═════════════════════════════════════════ */}
        <div style={{ width: 380, flexShrink: 0, overflowY: 'auto', padding: '20px 20px', background: '#FAFAFA' }}>
          {selectedId === null ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center', color: '#9CA3AF' }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#6B7280', marginBottom: 6 }}>Chưa chọn template</div>
              <div style={{ fontSize: 12 }}>Bấm <b>Xem</b> hoặc click vào một template bên trái để xem chi tiết.</div>
            </div>
          ) : detailLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9CA3AF', fontSize: 13 }}>
              Đang tải chi tiết…
            </div>
          ) : selectedDetail && selectedMeta ? (
            <TemplateDetailPanel
              detail={selectedDetail}
              meta={selectedMeta}
              onEdit={() => handleEdit(selectedMeta.id)}
              onUseForGrading={() => handleUseForGrading(selectedMeta.id)}
              onExport={() => handleExport(selectedMeta.id, selectedMeta.name)}
              onDuplicate={() => handleDuplicate(selectedMeta.id)}
              onDelete={() => handleDelete(selectedMeta.id, selectedMeta.name)}
              actionLoading={actionLoading === selectedMeta.id}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
