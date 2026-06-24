/**
 * FlowerCanvas.tsx
 * Decorative canvas: red gradient bg + glowing blobs + wave lines
 * + lotus watermarks (PNG, faint) + falling sakura petals (PNG).
 *
 * Assets loaded:
 *   /sakura.png  — white sakura flower, RGBA 1254×1254
 *   /lotus.png   — white lotus flower,  RGBA 1254×1254
 *
 * Falls back to simple circle if PNG hasn't loaded yet (< 1 frame).
 * Canvas is cleaned up on unmount.
 */
import { useEffect, useRef } from 'react';

export type FlowerVariant = 'auth' | 'landing' | 'cta';

interface Props {
  variant?: FlowerVariant;
  opacity?: number;
  drawBg?: boolean;
  style?: React.CSSProperties;
}

/* ── preload images once, globally ──────────────────────────── */
function loadImg(src: string): HTMLImageElement {
  const img = new Image();
  img.src = src;
  return img;
}
const SAKURA_IMG = loadImg('/sakura.png');
const LOTUS_IMG  = loadImg('/lotus.png');

/* ── petal state ─────────────────────────────────────────────── */
interface PetalState {
  x: number; y: number;
  sz: number;
  vy: number; drift: number;
  ph: number; rot: number; rs: number;
  a: number;
}

function makePetals(n: number): PetalState[] {
  return Array.from({ length: n }, () => ({
    x:     Math.random() * 900,
    y:     Math.random() * 800,
    sz:    22 + Math.random() * 26,        // 22-48 px radius
    vy:    0.32 + Math.random() * 0.52,    // fall speed
    drift: 0.20 + Math.random() * 0.38,   // horizontal sway
    ph:    Math.random() * Math.PI * 2,
    rot:   Math.random() * Math.PI * 2,
    rs:    (Math.random() - 0.5) * 0.020, // rotation speed
    a:     0.44 + Math.random() * 0.38,   // opacity 0.44-0.82
  }));
}

interface BlobState { bx: number; by: number; br: number; spx: number; spy: number; ph: number; }
function makeBlobs(n: number): BlobState[] {
  return Array.from({ length: n }, (_, i) => ({
    bx: 0.14 + i * 0.18,
    by: 0.14 + i * 0.17,
    br: 0.17 + Math.random() * 0.18,
    spx: 0.28 + Math.random() * 0.22,
    spy: 0.22 + Math.random() * 0.20,
    ph:  Math.random() * Math.PI * 2,
  }));
}

interface LotusWM { x: number; y: number; sz: number; ph: number; }
function makeLotusWM(): LotusWM[] {
  return [
    { x: 0.08, y: 0.90, sz: 110, ph: 0.4 },
    { x: 0.92, y: 0.06, sz: 95,  ph: 1.2 },
    { x: 0.52, y: 0.03, sz: 88,  ph: 2.1 },
  ];
}

/* ── draw helpers ────────────────────────────────────────────── */
/**
 * Draw an image (PNG) centred at (0,0), clipped to square 2r×2r.
 * Falls back to a faint circle if the image isn't loaded yet.
 */
function drawImgCentered(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  r: number,
) {
  if (img.complete && img.naturalWidth > 0) {
    const d = r * 2;
    ctx.drawImage(img, -r, -r, d, d);
  } else {
    // tiny fallback circle while PNG loads (< 1 frame)
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,220,228,0.7)';
    ctx.fill();
  }
}

/* ── component ───────────────────────────────────────────────── */
export default function FlowerCanvas({
  variant  = 'auth',
  opacity  = 1,
  drawBg   = true,
  style,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);

  const stateRef = useRef({
    petals:  makePetals(variant === 'landing' ? 26 : 20),
    blobs:   makeBlobs(5),
    lotuswm: makeLotusWM(),
  });

  useEffect(() => {
    stateRef.current = {
      petals:  makePetals(variant === 'landing' ? 26 : 20),
      blobs:   makeBlobs(5),
      lotuswm: makeLotusWM(),
    };
  }, [variant]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const ctx = canvas.getContext('2d')!;
    const { petals, blobs, lotuswm } = stateRef.current;

    const frame = (ts: number) => {
      const t = ts * 0.001;
      const W = canvas.width;
      const H = canvas.height;
      if (!W || !H) { rafRef.current = requestAnimationFrame(frame); return; }

      /* ─ background ─ */
      if (drawBg) {
        const bg = ctx.createLinearGradient(0, 0, W * 0.6, H);
        bg.addColorStop(0,    '#9B0020');
        bg.addColorStop(0.45, '#C8102E');
        bg.addColorStop(0.75, '#7B0018');
        bg.addColorStop(1,    '#1a0005');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
      } else {
        ctx.clearRect(0, 0, W, H);
      }

      /* ─ glowing blobs ─ */
      blobs.forEach(b => {
        const bx = (b.bx + 0.35 * Math.sin(t * b.spx + b.ph)) * W;
        const by = (b.by + 0.30 * Math.cos(t * b.spy + b.ph)) * H;
        const br = b.br * Math.min(W, H);
        const g  = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0,   'rgba(230,50,70,0.22)');
        g.addColorStop(0.5, 'rgba(180,0,30,0.12)');
        g.addColorStop(1,   'rgba(100,0,10,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
      });

      /* ─ wave lines ─ */
      for (let wi = 0; wi < 5; wi++) {
        const amp  = 28 + wi * 22;
        const freq = 0.0048 + wi * 0.0018;
        const yOff = H * (0.18 + wi * 0.16);
        const ph   = t * (0.28 + wi * 0.09);
        ctx.beginPath();
        ctx.strokeStyle = `rgba(255,255,255,${0.025 + wi * 0.008})`;
        ctx.lineWidth = 1.4;
        for (let x = 0; x <= W; x += 3) {
          const y = yOff + amp * Math.sin(freq * x + ph);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      /* ─ lotus watermarks — /lotus.png, faint, large, pulsing ─ */
      lotuswm.forEach(l => {
        const alpha = 0.055 + 0.030 * Math.sin(t * 0.35 + l.ph);
        ctx.save();
        ctx.translate(l.x * W, l.y * H);
        ctx.globalAlpha = alpha;
        drawImgCentered(ctx, LOTUS_IMG, l.sz);
        ctx.globalAlpha = 1;
        ctx.restore();
      });

      /* ─ falling sakura petals — /sakura.png ─ */
      petals.forEach(p => {
        p.y   += p.vy;
        p.x   += Math.sin(t * 0.5 + p.ph) * p.drift;
        p.rot += p.rs;
        if (p.y > H + 60) { p.y = -60; p.x = Math.random() * W; }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = p.a;
        drawImgCentered(ctx, SAKURA_IMG, p.sz);
        ctx.globalAlpha = 1;
        ctx.restore();
      });

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [drawBg, variant]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        opacity,
        ...style,
      }}
    />
  );
}
