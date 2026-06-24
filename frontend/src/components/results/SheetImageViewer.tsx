/**
 * SheetImageViewer.tsx
 *
 * Reusable sheet-image viewer used in:
 *   - ResultDetailModal (right panel)
 *   - EditModal in ReviewErrorsPage (right column)
 *
 * Structure
 * ┌─────────────────────────────────────────────────────────┐
 * │  [card: bg-slate-100, border, rounded-2xl, padding]     │
 * │  ┌─ header ──────────────────────────────────────────┐  │
 * │  │  Tabs │ Title + Subtitle + Badges │ Zoom toolbar  │  │
 * │  └───────────────────────────────────────────────────┘  │
 * │  ┌─ image area (bg-gray-200, flex-center) ────────────┐ │
 * │  │  <img object-contain>  or  empty-state             │ │
 * │  └────────────────────────────────────────────────────┘ │
 * └─────────────────────────────────────────────────────────┘
 */
import { useState } from 'react';
import {
  FileImage, ZoomIn, ZoomOut, Maximize2, AlertTriangle,
} from 'lucide-react';
import type { OmrDebugInfo } from '../../types/grading';

// ── Constants ────────────────────────────────────────────────────────────────
const BACKEND   = 'http://localhost:8000';
const ZOOM_STEP = 0.25;
const ZOOM_MIN  = 0.25;
const ZOOM_MAX  = 4;

// ── Types ─────────────────────────────────────────────────────────────────────
export type ImgTab = 'detect' | 'aligned' | 'original';

export interface SheetImageViewerProps {
  /** Debug fields from OmrGradeResult.debug — all optional */
  debug?: Partial<OmrDebugInfo>;
  /** Fallback for "original" path when debug.original_image_path is null (use r.input?.saved_as) */
  originalFallback?: string | null;
  /** Tab shown on first render. Default: 'detect' */
  defaultTab?: ImgTab;
  /** Extra className on the outermost div */
  className?: string;
}

// ── Per-tab metadata ──────────────────────────────────────────────────────────
interface TabMeta {
  key:      ImgTab;
  label:    string;
  subtitle: string;
}

const TAB_META: TabMeta[] = [
  { key: 'detect',   label: 'Ảnh detect',          subtitle: 'Overlay kết quả nhận diện bubble' },
  { key: 'aligned',  label: 'Ảnh đã căn chỉnh',    subtitle: 'Ảnh sau căn chỉnh phối cảnh'      },
  { key: 'original', label: 'Ảnh gốc',              subtitle: 'Ảnh upload ban đầu'               },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function imgUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return `${BACKEND}/${path.replace(/^\//, '')}`;
}

function zoomBtnStyle(active: boolean): React.CSSProperties {
  return {
    border: `1.5px solid ${active ? '#C8102E' : '#D1D5DB'}`,
    background: active ? '#FEF2F2' : '#fff',
    color: active ? '#C8102E' : '#374151',
    borderRadius: 7,
    padding: '4px 7px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'border-color 120ms, background 120ms',
  };
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function SheetImageViewer({
  debug = {},
  originalFallback,
  defaultTab = 'detect',
  className,
}: SheetImageViewerProps) {
  const [imgTab,   setImgTab]   = useState<ImgTab>(defaultTab);
  const [zoom,     setZoom]     = useState<number | 'fit'>('fit');
  const [imgError, setImgError] = useState<Record<string, boolean>>({});

  // ── Alignment quality gates ───────────────────────────────────────────────
  const warpRejected = debug.warp_used === false;
  const noAlignment  = !debug.prep_method || debug.prep_method === 'none';
  const alignedLabel = (warpRejected || noAlignment) ? 'Ảnh đã căn chỉnh ⚠' : 'Ảnh đã căn chỉnh';

  function alignedSubtitle(): string {
    if (warpRejected) return 'Warp bị bỏ qua — hiển thị ảnh gốc / CropPage';
    if (noAlignment)  return 'Không detect đủ 4 marker góc — chưa căn chỉnh phối cảnh';
    return 'Ảnh sau căn chỉnh phối cảnh';
  }

  function alignedPlaceholder(): string {
    if (warpRejected) return 'Ảnh đã căn chỉnh (warp bị bỏ qua)\nHiển thị ảnh gốc / CropPage';
    if (noAlignment)  return 'Ảnh chưa được căn chỉnh phối cảnh\n(không detect đủ 4 marker góc)';
    return 'Không tìm thấy ảnh đã căn chỉnh';
  }

  // ── Tab data ──────────────────────────────────────────────────────────────
  const tabs: { key: ImgTab; label: string; subtitle: string; path: string | null | undefined; placeholder: string }[] = [
    {
      key:         'detect',
      label:       'Ảnh detect',
      subtitle:    'Overlay kết quả nhận diện bubble',
      path:        debug.overlay_all_path,
      placeholder: 'Không tìm thấy ảnh detect',
    },
    {
      key:         'aligned',
      label:       alignedLabel,
      subtitle:    alignedSubtitle(),
      path:        debug.aligned_image_path,
      placeholder: alignedPlaceholder(),
    },
    {
      key:         'original',
      label:       'Ảnh gốc',
      subtitle:    'Ảnh upload ban đầu',
      path:        debug.original_image_path ?? originalFallback,
      placeholder: 'Không tìm thấy ảnh gốc',
    },
  ];

  const currentTab = tabs.find(t => t.key === imgTab)!;
  const currentUrl = imgUrl(currentTab.path);

  // ── Zoom helpers ──────────────────────────────────────────────────────────
  const zoomPct = zoom === 'fit' ? 'Fit' : `${Math.round((zoom as number) * 100)}%`;

  function changeZoom(delta: number) {
    setZoom(prev => {
      const base = prev === 'fit' ? 1 : (prev as number);
      return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((base + delta) * 100) / 100));
    });
  }

  function changeTab(key: ImgTab) {
    setImgTab(key);
    setZoom('fit');
    setImgError(prev => ({ ...prev, [key]: false }));
  }

  const imgStyle: React.CSSProperties = zoom === 'fit'
    ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', borderRadius: 6 }
    : { width: `${(zoom as number) * 100}%`, maxWidth: 'none', display: 'block', borderRadius: 6 };

  // ── Debug badges (shown in header under subtitle) ─────────────────────────
  const badges: { text: string; color: string; bg: string; icon?: React.ReactNode }[] = [];
  if (imgTab === 'aligned') {
    if (warpRejected) {
      badges.push({
        text: `Không warp${debug.warp_rejected_reason ? ` (${debug.warp_rejected_reason})` : ''}`,
        bg: 'rgba(251,191,36,0.18)', color: '#78350F', icon: <AlertTriangle size={11} style={{ flexShrink: 0 }} />,
      });
    }
    if (debug.visual_aligned_mode === 'rectified_keep_aspect') {
      badges.push({
        text: `Đã kéo phẳng theo marker, giữ tỉ lệ thật${debug.estimated_h_stretch != null ? ` (H-stretch ≈ ${debug.estimated_h_stretch.toFixed(1)}%)` : ''}`,
        bg: 'rgba(59,130,246,0.10)', color: '#1E40AF',
      });
    }
    if (debug.visual_aligned_mode === 'original_no_stretch') {
      badges.push({
        text: `Hiển thị ảnh gốc để tránh méo${debug.estimated_h_stretch != null ? ` (H-stretch ≈ ${debug.estimated_h_stretch.toFixed(1)}%)` : ''}`,
        bg: 'rgba(59,130,246,0.10)', color: '#1E40AF',
      });
    }
    if (debug.visual_aligned_mode === 'warp') {
      badges.push({
        text: 'Warp về template canvas',
        bg: 'rgba(16,185,129,0.10)', color: '#065F46',
      });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: '#F1F5F9',          // slate-100
        border: '1px solid #E2E8F0',    // slate-200
        borderRadius: 16,
        overflow: 'hidden',
      }}
    >
      {/* ── Header ── */}
      <div style={{
        background: '#fff',
        borderBottom: '1px solid #E2E8F0',
        padding: '10px 14px',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}>

        {/* Row 1: tabs + zoom toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>

          {/* Tab buttons */}
          <div style={{ display: 'flex', gap: 4, flex: 1, flexWrap: 'wrap' }}>
            {tabs.map(t => {
              const active = imgTab === t.key;
              const avail  = !!imgUrl(t.path);
              return (
                <button
                  key={t.key}
                  onClick={() => changeTab(t.key)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    border: '1.5px solid',
                    borderColor: active ? '#C8102E' : '#E2E8F0',
                    background: active ? '#C8102E' : '#fff',
                    color: active ? '#fff' : avail ? '#374151' : '#9CA3AF',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    transition: 'border-color 120ms, background 120ms',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Zoom controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <button onClick={() => setZoom('fit')} title="Fit" style={zoomBtnStyle(zoom === 'fit')}>
              <Maximize2 size={13} />
            </button>
            <button onClick={() => changeZoom(-ZOOM_STEP)} title="Zoom out" style={zoomBtnStyle(false)}>
              <ZoomOut size={13} />
            </button>
            <span style={{
              fontSize: 11, fontWeight: 700, color: '#374151',
              minWidth: 38, textAlign: 'center',
            }}>
              {zoomPct}
            </span>
            <button onClick={() => changeZoom(+ZOOM_STEP)} title="Zoom in" style={zoomBtnStyle(false)}>
              <ZoomIn size={13} />
            </button>
          </div>
        </div>

        {/* Row 2: title + subtitle */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1E293B' }}>
            {currentTab.label}
          </div>
          <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
            {currentTab.subtitle}
          </div>
        </div>

        {/* Row 3: debug badges (only if any) */}
        {badges.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {badges.map((b, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: 5,
                background: b.bg,
                color: b.color,
                borderRadius: 7,
                padding: '5px 9px',
                fontSize: 11,
                fontWeight: 600,
              }}>
                {b.icon}
                <span>{b.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Image area ── */}
      <div style={{
        flex: 1,
        background: '#CBD5E1',    // slate-300 — clearly different from white sheet
        overflow: zoom === 'fit' ? 'hidden' : 'auto',
        display: 'flex',
        alignItems: zoom === 'fit' ? 'center' : 'flex-start',
        justifyContent: zoom === 'fit' ? 'center' : 'flex-start',
        minHeight: 0,
        padding: zoom === 'fit' ? 12 : 0,
        position: 'relative',
      }}>
        {!currentUrl || imgError[imgTab] ? (
          /* Empty state */
          <div style={{
            textAlign: 'center', color: '#94A3B8', padding: '32px 20px',
          }}>
            <FileImage
              size={52}
              style={{ margin: '0 auto 14px', opacity: 0.35, display: 'block' }}
            />
            <div style={{ fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 6 }}>
              Không có ảnh debug
            </div>
            <div style={{ fontSize: 12, color: '#94A3B8', lineHeight: 1.55 }}>
              Ảnh này chưa được backend trả về hoặc file đã bị xoá
            </div>
            {currentTab.path && (
              <div style={{
                marginTop: 10, fontSize: 10, color: '#CBD5E1',
                wordBreak: 'break-all', maxWidth: 320, margin: '10px auto 0',
              }}>
                {currentTab.path}
              </div>
            )}
          </div>
        ) : (
          <img
            key={currentUrl + String(zoom)}
            src={currentUrl}
            alt={currentTab.label}
            onError={() => setImgError(prev => ({ ...prev, [imgTab]: true }))}
            style={imgStyle}
          />
        )}
      </div>
    </div>
  );
}
