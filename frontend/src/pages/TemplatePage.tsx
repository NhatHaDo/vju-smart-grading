/**
 * TemplatePage.tsx — Quản lý template phiếu
 *
 * - List custom templates của user từ API
 * - Actions: Sửa (→ /app/ocr-qr?templateId=…), Đổi tên, Nhân bản, Xoá, Export JSON
 * - Load: đặt selected template cho phase sau (lưu vào sessionStorage)
 */
import { useState, useEffect, useRef } from 'react';
import { Pencil, Trash2, Copy, Download, RefreshCw, Plus } from 'lucide-react';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Badge from '../components/common/Badge';
import PageHeader from '../components/layout/PageHeader';
import { useNavigate } from 'react-router-dom';
import { customFormsApi, ApiError } from '../services/apiClient';
import type { CustomFormMeta } from '../services/apiClient';

// ── Schematic preview SVG ─────────────────────────────────────────────────────

function TemplatePreviewSvg({ areaCount }: { areaCount: number }) {
  const rows = 6; const cols = 4;
  const filled = Math.min(areaCount * 2, rows * cols);
  return (
    <svg viewBox={`0 0 ${cols * 18 + 4} ${rows * 18 + 4}`} style={{ width: '100%', maxWidth: 120 }}>
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TemplatePage() {
  const [forms, setForms]           = useState<CustomFormMeta[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    try { return JSON.parse(sessionStorage.getItem('vju_selected_template') ?? 'null'); }
    catch { return null; }
  });
  const navigate = useNavigate();

  // ── Fetch ──────────────────────────────────────────────────────────────────
  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await customFormsApi.list();
      setForms(data.forms as CustomFormMeta[]);
    } catch (e: unknown) {
      // 401 auto-refreshed by apiClient; if refresh fails → vju-auth-expired → AuthProvider → redirect
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return;
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // ── Actions ────────────────────────────────────────────────────────────────
  async function handleRename(id: number, name: string) {
    if (!name.trim()) return;
    setActionLoading(id);
    try {
      await customFormsApi.rename(id, name);
      setForms(prev => prev.map(f => f.id === id ? { ...f, name } : f));
    } catch (e: unknown) {
      alert(`Đổi tên thất bại: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setActionLoading(null);
      setRenamingId(null);
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!window.confirm(`Xoá template "${name}"? Hành động này không thể hoàn tác.`)) return;
    setActionLoading(id);
    try {
      await customFormsApi.delete(id);
      setForms(prev => prev.filter(f => f.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
        sessionStorage.removeItem('vju_selected_template');
      }
    } catch (e: unknown) {
      alert(`Xoá thất bại: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setActionLoading(null);
    }
  }

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

  async function handleExport(id: number, name: string) {
    try {
      const data = await customFormsApi.get(id);
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

  function handleLoad(id: number) {
    setSelectedId(id);
    sessionStorage.setItem('vju_selected_template', JSON.stringify(id));
    navigate('/app/upload');
  }

  function handleEdit(id: number) {
    navigate(`/app/ocr-qr?templateId=${id}`);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const btnStyle = (color?: string): React.CSSProperties => ({
    border: `1.5px solid ${color ?? '#E5E7EB'}`,
    borderRadius: 9999,
    padding: '4px 11px',
    fontSize: 11,
    fontWeight: 600,
    color: color ?? '#374151',
    background: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    opacity: 1,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title="Template phiếu"
        subtitle="Quản lý custom template đã define"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" icon={<RefreshCw size={13} />} variant="secondary" onClick={load}>
              Làm mới
            </Button>
            <Button size="sm" icon={<Plus size={13} />} onClick={() => navigate('/app/ocr-qr')}>
              Define phiếu mới
            </Button>
          </div>
        }
      />

      <div style={{ padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Error */}
        {error && (
          <Card style={{ padding: '12px 16px', background: '#FEF2F2', border: '1px solid #FECACA' }}>
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
            <Button size="sm" icon={<Plus size={13} />} onClick={() => navigate('/app/ocr-qr')}>
              Define phiếu đầu tiên
            </Button>
          </Card>
        )}

        {/* Template cards */}
        {!loading && forms.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            {forms.map(f => {
              const isSelected = f.id === selectedId;
              const busy = actionLoading === f.id;
              return (
                <div
                  key={f.id}
                  onClick={() => !renamingId && handleLoad(f.id)}
                  style={{
                    width: 240,
                    border: `2px solid ${isSelected ? '#C8102E' : '#E5E7EB'}`,
                    borderRadius: 12,
                    padding: '14px 16px',
                    background: isSelected ? '#FFF9F9' : '#fff',
                    cursor: 'pointer',
                    transition: 'border-color 150ms, box-shadow 150ms',
                    boxShadow: isSelected ? '0 0 0 3px rgba(200,16,46,0.12)' : undefined,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {renamingId === f.id ? (
                        <RenameInput
                          value={f.name}
                          onSave={name => handleRename(f.id, name)}
                          onCancel={() => setRenamingId(null)}
                        />
                      ) : (
                        <div style={{ fontWeight: 700, fontSize: 13, color: '#1E1E1E', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {f.name}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 6 }}>
                      {f.is_default && <Badge color="green">Mặc định</Badge>}
                      {isSelected && <Badge color="red">Đang dùng</Badge>}
                    </div>
                  </div>

                  {/* SVG preview */}
                  <div style={{ marginBottom: 10 }}>
                    <TemplatePreviewSvg areaCount={f.area_count} />
                  </div>

                  {/* Meta */}
                  <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 10, lineHeight: 1.7 }}>
                    <div>{f.area_count} vùng OMR</div>
                    {f.page_width && f.page_height && (
                      <div>{f.page_width} × {f.page_height}</div>
                    )}
                    <div>Cập nhật: {f.updated_at.replace('T', ' ').slice(0, 16)}</div>
                  </div>

                  {/* Actions row 1 */}
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
                    <button style={btnStyle('#C8102E')} onClick={e => { e.stopPropagation(); handleLoad(f.id); }}>
                      {isSelected ? '✓ Đang load' : 'Load'}
                    </button>
                    <button style={btnStyle()} onClick={e => { e.stopPropagation(); handleEdit(f.id); }}>
                      <Pencil size={10} /> Sửa
                    </button>
                    {!f.is_default && renamingId !== f.id && (
                      <button style={btnStyle()} onClick={e => { e.stopPropagation(); setRenamingId(f.id); }}>
                        Đổi tên
                      </button>
                    )}
                  </div>

                  {/* Actions row 2 */}
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <button style={btnStyle()} onClick={e => { e.stopPropagation(); handleDuplicate(f.id); }}
                      disabled={busy}>
                      <Copy size={10} /> Nhân bản
                    </button>
                    <button style={btnStyle()} onClick={e => { e.stopPropagation(); handleExport(f.id, f.name); }}>
                      <Download size={10} /> Export
                    </button>
                    {!f.is_default && (
                      <button
                        style={{ ...btnStyle('#FECACA'), color: '#C8102E' }}
                        onClick={e => { e.stopPropagation(); handleDelete(f.id, f.name); }}
                        disabled={busy}>
                        <Trash2 size={10} /> Xoá
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Selected template info */}
        {selectedId && forms.find(f => f.id === selectedId) && (() => {
          const sel = forms.find(f => f.id === selectedId)!;
          return (
            <Card style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
                Template đang load: <span style={{ color: '#C8102E' }}>{sel.name}</span>
              </div>
              <div style={{ fontSize: 12, color: '#6B7280' }}>
                ID: {sel.id} · {sel.area_count} vùng
                {sel.page_width && sel.page_height && ` · ${sel.page_width}×${sel.page_height}`}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: '#6B7280', background: '#F9FAFB', padding: '7px 10px', borderRadius: 7 }}>
                Đang chuyển đến trang upload để chấm phiếu với template này…
              </div>
            </Card>
          );
        })()}

      </div>
    </div>
  );
}
