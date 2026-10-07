/**
 * AppIntro — the opening animation of the iPhone app (2026-10-07).
 *
 * "lúc chờ mở app thì cái hoa sen với hoa anh đào chập vào xong từ từ hiện
 * logo VJU": the lotus rises from below and the sakura flies in from the top
 * corner on the VJU red, the red closes into the round mark, the mark moves
 * left and "VJU – Vietnam Japan University" appears beside it (the full logo
 * on white), then it fades into the app. About 2.6 s.
 *
 * iOS only allows a still launch screen, so that screen is plain red (the
 * first frame here) and index.html keeps the page red until this runs.
 * Runs only inside the app (Capacitor) and once per app start
 * (sessionStorage); ?intro=1 shows it in a browser for testing. With
 * "Reduce Motion" on, the logo just appears and fades.
 */
import { useEffect, useRef, useState } from 'react';

const RED = '#AA2222';
const T = 2600;
// logo layout (px in the 1116×486 logo the pieces were cut from)
const LOGO_W = 1116, LOGO_H = 486, CIRCLE_X = 33, CIRCLE_Y = 59, CIRCLE_D = 394, TEXT_X = 440, TEXT_W = 676;

function shouldRun(): boolean {
  try {
    if (!document.documentElement.classList.contains('vju-intro')) return false;
    return true;
  } catch { return false; }
}

function finish() {
  try { sessionStorage.setItem('vju_intro_done', '1'); } catch { /* ignore */ }
  document.documentElement.classList.remove('vju-intro');
}

export default function AppIntro() {
  const [show, setShow] = useState(shouldRun);
  const red = useRef<HTMLDivElement>(null), group = useRef<HTMLDivElement>(null), disk = useRef<HTMLDivElement>(null);
  const lotus = useRef<HTMLImageElement>(null), sakura = useRef<HTMLImageElement>(null), text = useRef<HTMLImageElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    const anims: Animation[] = [];
    const imgs = [lotus.current, sakura.current, text.current].filter(Boolean) as HTMLImageElement[];
    // wait for the three pictures (they come over the network), at most 2.5 s
    const ready = Promise.race([
      Promise.all(imgs.map(i => i.decode().catch(() => undefined))),
      new Promise(r => setTimeout(r, 2500)),
    ]);
    ready.then(() => {
      if (cancelled || !root.current || !group.current || !text.current) return;
      const W = root.current.clientWidth, H = root.current.clientHeight;
      const Lw = Math.min(W * 0.8, 420), s = Lw / LOGO_W, Lx = (W - Lw) / 2, Ly = (H - LOGO_H * s) / 2;
      const D = CIRCLE_D * s, gx = Lx + CIRCLE_X * s, gy = Ly + CIRCLE_Y * s;
      Object.assign(group.current.style, { left: `${gx}px`, top: `${gy}px`, width: `${D}px`, height: `${D}px` });
      Object.assign(text.current.style, { left: `${Lx + TEXT_X * s}px`, top: `${Ly}px`, width: `${TEXT_W * s}px`, height: `${LOGO_H * s}px` });
      const big = Math.min((W * 0.78) / D, 2.6);
      const dx = W / 2 - (gx + D / 2), dy = H / 2 - (gy + D / 2);
      const o = (ms: number) => ms / T;
      const A = (el: Element | null, kf: Keyframe[]) => {
        if (!el) return;
        anims.push(el.animate(kf, { duration: T, fill: 'both' }));
      };
      const ease = 'cubic-bezier(.22,.8,.24,1)';
      const center = `translate(${dx}px,${dy}px) scale(${big})`, home = 'translate(0px,0px) scale(1)';
      // the page under the intro is white from here on (red only while waiting)
      document.documentElement.classList.remove('vju-intro');

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const fade: Keyframe[] = [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }];
        A(red.current, [{ opacity: 0 }, { opacity: 0 }]);
        A(group.current, [{ transform: home, opacity: 0 }, { transform: home, opacity: 1, offset: 0.15 }, { transform: home, opacity: 1, offset: 0.85 }, { transform: home, opacity: 0 }]);
        A(disk.current, [{ opacity: 1 }, { opacity: 1 }]);
        A(text.current, fade);
        A(root.current, [{ background: '#fff' }, { background: '#fff', offset: 0.85 }, { background: 'rgba(255,255,255,0)' }]);
      } else {
        const R0 = Math.hypot(W, H), r1 = (D * big) / 2;
        A(red.current, [
          { clipPath: `circle(${R0}px at 50% 50%)`, opacity: 1 },
          { clipPath: `circle(${R0}px at 50% 50%)`, opacity: 1, offset: o(750) },
          { clipPath: `circle(${r1}px at 50% 50%)`, opacity: 1, offset: o(1150) },
          { clipPath: `circle(${r1}px at 50% 50%)`, opacity: 0, offset: o(1160) },
          { clipPath: `circle(${r1}px at 50% 50%)`, opacity: 0 },
        ]);
        A(disk.current, [{ opacity: 0 }, { opacity: 0, offset: o(1150) }, { opacity: 1, offset: o(1160) }, { opacity: 1 }]);
        A(group.current, [
          { transform: center, opacity: 1 }, { transform: center, opacity: 1, offset: o(1150), easing: ease },
          { transform: home, opacity: 1, offset: o(1700) }, { transform: home, opacity: 1, offset: o(2300) }, { transform: home, opacity: 0 },
        ]);
        A(lotus.current, [
          { transform: 'translate(-6%,70%) scale(1.15)', opacity: 0 }, { transform: 'translate(-6%,70%) scale(1.15)', opacity: 0, offset: o(100), easing: ease },
          { transform: 'none', opacity: 1, offset: o(750) }, { transform: 'none', opacity: 1 },
        ]);
        A(sakura.current, [
          { transform: 'translate(60%,-70%) rotate(-70deg) scale(.6)', opacity: 0 }, { transform: 'translate(60%,-70%) rotate(-70deg) scale(.6)', opacity: 0, offset: o(220), easing: ease },
          { transform: 'none', opacity: 1, offset: o(800) }, { transform: 'none', opacity: 1 },
        ]);
        A(text.current, [
          { opacity: 0, transform: 'translateX(18px)', clipPath: 'inset(0 100% 0 0)' },
          { opacity: 0, transform: 'translateX(18px)', clipPath: 'inset(0 100% 0 0)', offset: o(1450), easing: ease },
          { opacity: 1, transform: 'none', clipPath: 'inset(0 0 0 0)', offset: o(1900) },
          { opacity: 1, transform: 'none', clipPath: 'inset(0 0 0 0)', offset: o(2300) },
          { opacity: 0, transform: 'none', clipPath: 'inset(0 0 0 0)' },
        ]);
        // the white ground fades with the logo, showing the app underneath
        A(root.current, [{ background: '#fff' }, { background: '#fff', offset: o(2300) }, { background: 'rgba(255,255,255,0)' }]);
      }
      anims[anims.length - 1]?.finished.then(() => { if (!cancelled) { finish(); setShow(false); } }).catch(() => undefined);
    });
    // never leave the intro on screen if something goes wrong
    const safety = setTimeout(() => { finish(); setShow(false); }, T + 4000);
    return () => { cancelled = true; clearTimeout(safety); anims.forEach(a => a.cancel()); };
  }, [show]);

  if (!show) return null;
  const abs: React.CSSProperties = { position: 'absolute', display: 'block' };
  return (
    <div ref={root} aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 10000, background: '#fff', overflow: 'hidden', pointerEvents: 'none' }}>
      <div ref={red} style={{ position: 'absolute', inset: 0, background: RED }} />
      <div ref={group} style={{ position: 'absolute', left: '50%', top: '50%', width: 0, height: 0, transformOrigin: '50% 50%' }}>
        <div ref={disk} style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: RED, opacity: 0 }} />
        <img ref={lotus} src="/intro/lotus.png" alt="" style={{ ...abs, inset: 0, width: '100%', height: '100%', opacity: 0 }} />
        <img ref={sakura} src="/intro/sakura.png" alt="" style={{ ...abs, inset: 0, width: '100%', height: '100%', opacity: 0 }} />
      </div>
      <img ref={text} src="/intro/vju-text.png" alt="" style={{ ...abs, opacity: 0 }} />
    </div>
  );
}
