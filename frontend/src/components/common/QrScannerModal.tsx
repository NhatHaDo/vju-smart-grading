/**
 * QrScannerModal.tsx — live camera QR scanner, like the QM app's "Quét mã QR":
 * point the phone at the mã QR đáp án and it is read on its own (jsQR, in
 * the browser — no photo to take, nothing sent until a code is found).
 * "Chọn ảnh có mã QR" stays as a fallback (screenshot / ảnh gửi qua Zalo).
 */
import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { X, Image as ImageIcon } from 'lucide-react';

export default function QrScannerModal({ open, onClose, onText, onImage, title = 'Quét mã QR đáp án' }: {
  open: boolean;
  onClose: () => void;
  /** a code was read: the caller loads its đáp án (the scanner closes first) */
  onText: (text: string) => void;
  /** fallback: a picture picked from the phone */
  onImage: (file: File) => void;
  title?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    let stream: MediaStream | null = null;
    let raf = 0;
    let last = 0;
    let done = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const v = videoRef.current;
      if (done || !v || !ctx || v.readyState < 2 || t - last < 120) return;
      last = t;
      // the middle of the picture, scaled down — fast enough on a phone
      const side = Math.min(v.videoWidth, v.videoHeight);
      const size = Math.min(720, side);
      canvas.width = size; canvas.height = size;
      ctx.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, size, size);
      const code = jsQR(ctx.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: 'dontInvert' });
      if (code?.data) {
        done = true;
        try { navigator.vibrate?.(80); } catch { /* ignore */ }
        onClose();
        onText(code.data);
      }
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Không mở được camera ở đây (cần HTTPS). Dùng "Chọn ảnh có mã QR" bên dưới.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
        });
        if (done) { stream.getTracks().forEach(tr => tr.stop()); return; }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => { /* autoplay may need the tap that opened us */ });
        }
        raf = requestAnimationFrame(tick);
      } catch {
        setError('Chưa được phép dùng camera. Cho phép camera trong cài đặt, hoặc dùng "Chọn ảnh có mã QR".');
      }
    })();

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach(tr => tr.stop());
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 600, background: '#000', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 'calc(12px + env(safe-area-inset-top, 0px)) 16px 12px', color: '#fff' }}>
        <div style={{ flex: 1, fontSize: 16, fontWeight: 700 }}>{title}</div>
        <button type="button" onClick={onClose} aria-label="Đóng"
          style={{ border: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 9999, width: 36, height: 36,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <X size={18} color="#fff" />
        </button>
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <video ref={videoRef} playsInline muted autoPlay
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        {/* the frame to put the mã QR in */}
        <div style={{ position: 'absolute', left: '50%', top: '50%', width: 'min(70vw, 60vh)', aspectRatio: '1',
          transform: 'translate(-50%, -50%)', border: '3px solid #fff', borderRadius: 18,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 24, textAlign: 'center', color: '#fff', fontSize: 14, padding: '0 20px' }}>
          {error || 'Đưa mã QR đáp án vào khung, máy tự nhận và điền đáp án'}
        </div>
      </div>
      <div style={{ padding: '14px 16px calc(14px + env(safe-area-inset-bottom, 0px))', display: 'flex', justifyContent: 'center' }}>
        <button type="button" onClick={() => fileRef.current?.click()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: '1.5px solid rgba(255,255,255,0.5)', background: 'transparent',
            color: '#fff', borderRadius: 9999, padding: '9px 16px', fontSize: 14, fontFamily: 'inherit', cursor: 'pointer' }}>
          <ImageIcon size={16} /> Chọn ảnh có mã QR
        </button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { onClose(); onImage(f); } }} />
      </div>
    </div>
  );
}
