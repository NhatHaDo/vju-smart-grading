/**
 * ZoomableImage — a picture opened full screen on a phone (2026-10-07).
 *
 * "xem nnay ko thấy được ảnh rõ (lại phải ấn nút zoom ảnh, xong nó cứ bị
 * lệch/khó xem)": like the phone's own photo viewer — two fingers to zoom,
 * one finger to move around once zoomed, double tap to zoom in / back out,
 * ✕ to close. The page itself can't pinch-zoom (index.html maximum-scale=1),
 * so the zoom is done here on the picture alone.
 */
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

const MAX_SCALE = 6;

interface Props {
  src: string;
  alt?: string;
  onClose: () => void;
}

export default function ZoomableImage({ src, alt, onClose }: Props) {
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const tRef = useRef(t);
  tRef.current = t;
  const gesture = useRef<{ dist: number; s: number; x: number; y: number; px: number; py: number } | null>(null);
  const lastTap = useRef(0);

  // the page behind must not scroll while the picture is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(1, s));
  const dist = (a: React.Touch, b: React.Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  const onTouchStart = (e: React.TouchEvent) => {
    const cur = tRef.current;
    if (e.touches.length === 2) {
      gesture.current = { dist: dist(e.touches[0], e.touches[1]), s: cur.s, x: cur.x, y: cur.y, px: 0, py: 0 };
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap.current < 280) {           // double tap
        lastTap.current = 0;
        setT(cur.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 });
        gesture.current = null;
        return;
      }
      lastTap.current = now;
      gesture.current = { dist: 0, s: cur.s, x: cur.x, y: cur.y, px: e.touches[0].clientX, py: e.touches[0].clientY };
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (e.touches.length === 2 && g.dist > 0) {
      const s = clamp(g.s * dist(e.touches[0], e.touches[1]) / g.dist);
      setT({ s, x: s === 1 ? 0 : g.x, y: s === 1 ? 0 : g.y });
    } else if (e.touches.length === 1 && g.dist === 0 && tRef.current.s > 1) {
      setT({ s: tRef.current.s, x: g.x + (e.touches[0].clientX - g.px), y: g.y + (e.touches[0].clientY - g.py) });
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) gesture.current = null;
    else if (e.touches.length === 1) {
      // one finger left after a pinch: continue as a move from here
      const cur = tRef.current;
      gesture.current = { dist: 0, s: cur.s, x: cur.x, y: cur.y, px: e.touches[0].clientX, py: e.touches[0].clientY };
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 3000, background: '#000', touchAction: 'none', overflow: 'hidden' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <img
        src={src}
        alt={alt ?? ''}
        draggable={false}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain',
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`,
          transition: gesture.current ? 'none' : 'transform 160ms ease-out',
          userSelect: 'none',
        }}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Đóng"
        style={{
          position: 'absolute', top: 'calc(12px + env(safe-area-inset-top, 0px))', right: 12,
          width: 40, height: 40, borderRadius: 20, border: 'none', cursor: 'pointer',
          background: 'rgba(255,255,255,0.18)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <X size={22} />
      </button>
      {t.s === 1 && (
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
          textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: 12, pointerEvents: 'none',
        }}>
          Dùng 2 ngón để phóng to · chạm 2 lần để phóng nhanh
        </div>
      )}
    </div>
  );
}
