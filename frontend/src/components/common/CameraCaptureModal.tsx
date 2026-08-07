import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, X, RotateCcw, Check, Zap, Hand } from 'lucide-react';
import Button from './Button';

interface CameraCaptureModalProps {
  /** Called once per photo taken — modal stays open so the user can keep
   *  shooting a whole stack of sheets in a row (2026-08-04: "chụp ảnh trên
   *  web", Giai đoạn 1 của kế hoạch camera). */
  onCapture: (file: File) => void;
  onClose: () => void;
}

type Mode = 'auto' | 'manual';
type AutoState = 'searching' | 'holding' | 'clearing';

// 2026-08-04: Giai đoạn 3 — "giơ máy lên là tự chấm". Cứ mỗi POLL_INTERVAL_MS
// gửi 1 khung hình nhỏ lên /omr/quick-check hỏi "phiếu đã vào đúng vị trí
// chưa"; cần READY_STREAK_NEEDED lần liên tiếp trả về ready=true (tay đang
// giữ ổn định) mới tự động chụp ảnh full-res — tránh chụp hụt lúc đang di
// chuyển máy. Dùng đường dẫn TƯƠNG ĐỐI (/api/...) chứ không phải
// VITE_API_BASE tuyệt đối như debug-grade — khi test qua cloudflared tunnel
// trên điện thoại, "localhost" tuyệt đối sẽ trỏ vào chính điện thoại chứ
// không phải máy dev; đường dẫn tương đối đi qua đúng proxy /api của Vite.
const POLL_INTERVAL_MS = 450;
const READY_STREAK_NEEDED = 3;
const QUICK_CHECK_WIDTH = 480;

/**
 * Full-screen camera capture overlay.
 *
 * Opens the device's rear camera (facingMode "environment" — this is for
 * photographing answer sheets, never a selfie). Two modes:
 *  - "auto"   : giữ camera mở, tự nhận diện + tự chụp khi phiếu vào đúng vị trí
 *  - "manual" : giáo viên tự bấm nút chụp — dự phòng khi ánh sáng/góc chụp
 *               khó khiến chế độ tự động không bắt được (xem Mục 5 kế hoạch).
 *
 * Requires a secure context (HTTPS or localhost) — on a plain HTTP origin
 * `navigator.mediaDevices` is undefined and we show an explanatory message
 * instead of a blank/broken camera view.
 */
export default function CameraCaptureModal({ onCapture, onClose }: CameraCaptureModalProps) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error,       setError]       = useState<string | null>(null);
  const [starting,    setStarting]    = useState(true);
  const [shotCount,   setShotCount]   = useState(0);
  const [flash,       setFlash]       = useState(false);
  const [mode,        setMode]        = useState<Mode>('auto');
  const [autoState,   setAutoState]   = useState<AutoState>('searching');
  const [readyStreak, setReadyStreak] = useState(0);
  // 2026-08-04: "chưa biết căn nnao nó đã chụp" — chụp xong (auto lẫn thủ
  // công) giờ dừng lại ở đây để xem trước, chưa gửi đi luôn. Người dùng bấm
  // "Dùng ảnh này" mới thực sự gọi onCapture(); "Chụp lại" thì huỷ, quay về
  // khung hình sống.
  const [pendingCapture, setPendingCapture] = useState<{ file: File; url: string } | null>(null);
  // Luôn phản ánh pendingCapture mới nhất — đọc/ghi ref không có side effect
  // nên an toàn dùng trong các hàm bên dưới (xem giải thích ở captureFullRes).
  const pendingCaptureRef = useRef(pendingCapture);
  pendingCaptureRef.current = pendingCapture;

  const checkingRef      = useRef(false);   // 1 quick-check đang bay, bỏ qua vòng kế tiếp
  const waitingClearRef  = useRef(false);   // vừa auto-chụp — chờ phiếu rời khung mới chụp tiếp
  const readyStreakRef   = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      setStarting(true);
      setError(null);
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Trình duyệt không hỗ trợ camera ở đây, hoặc trang web chưa chạy trên HTTPS (bắt buộc để dùng camera).');
        setStarting(false);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError') {
          setError('Bạn chưa cho phép dùng camera. Vào cài đặt trình duyệt cấp lại quyền Camera cho trang này rồi thử lại.');
        } else if (name === 'NotFoundError') {
          setError('Không tìm thấy camera trên thiết bị này.');
        } else {
          setError(`Không mở được camera: ${(err as Error)?.message ?? 'lỗi không rõ'}`);
        }
      } finally {
        if (!cancelled) setStarting(false);
      }
    };

    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
  }, []);

  const handleClose = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    onClose();
  };

  // Chụp ảnh full-res từ khung hình hiện tại — dừng lại ở bước xem trước
  // (pendingCapture), CHƯA gọi onCapture(). Dùng chung cho cả nút bấm thủ
  // công lẫn trigger tự động.
  //
  // 2026-08-05: "t ấn chụp 1 lần sao n ra tận 2 cái giống nhau" — root cause:
  // this (và confirmCapture/retakeCapture bên dưới) từng gọi side effect
  // (URL.createObjectURL/revokeObjectURL, và tệ hơn là onCapture(...) trong
  // confirmCapture) ngay BÊN TRONG hàm updater truyền cho setPendingCapture
  // (setPendingCapture(prev => {...})). App bọc trong <StrictMode> (xem
  // main.tsx) — React cố tình gọi hàm updater này 2 LẦN ở dev để phát hiện
  // updater không "pure", nên mọi side effect bên trong (kể cả onCapture)
  // cũng chạy 2 lần mỗi lần bấm 1 lần thật → 2 file giống hệt nhau (cùng
  // tên, cùng nội dung) bị đẩy vào SheetReviewPage. Sửa bằng cách đọc/ghi
  // pendingCaptureRef (ref thuần, không phải side effect React cần canh
  // chừng) thay vì cái pattern updater có side effect ở trên.
  const captureFullRes = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(blob => {
      if (!blob) return;
      const ts = new Date();
      const stamp = ts.toISOString().replace(/[:.]/g, '-');
      const file = new File([blob], `camera_${stamp}.jpg`, { type: 'image/jpeg' });
      setFlash(true);
      setTimeout(() => setFlash(false), 180);
      if (pendingCaptureRef.current) URL.revokeObjectURL(pendingCaptureRef.current.url);
      const next = { file, url: URL.createObjectURL(blob) };
      pendingCaptureRef.current = next;
      setPendingCapture(next);
    }, 'image/jpeg', 0.92);
  }, []);

  // Xác nhận ảnh vừa xem trước — giờ mới thực sự gửi cho caller.
  const confirmCapture = useCallback(() => {
    const cur = pendingCaptureRef.current;
    if (!cur) return;
    onCapture(cur.file);
    setShotCount(n => n + 1);
    URL.revokeObjectURL(cur.url);
    pendingCaptureRef.current = null;
    setPendingCapture(null);
    // Phòng khi đang ở chế độ thủ công rồi chuyển qua Tự động ngay sau đó —
    // vẫn cần "chờ phiếu rời khung" giống như luồng tự động, tránh chụp
    // lại đúng phiếu vừa xác nhận.
    waitingClearRef.current = true;
  }, [onCapture]);

  // Huỷ ảnh vừa chụp, quay lại khung hình sống để chụp lại.
  const retakeCapture = useCallback(() => {
    const cur = pendingCaptureRef.current;
    if (cur) URL.revokeObjectURL(cur.url);
    pendingCaptureRef.current = null;
    setPendingCapture(null);
    waitingClearRef.current = false;
    readyStreakRef.current = 0;
    setReadyStreak(0);
    setAutoState('searching');
  }, []);

  // Reset trạng thái nhận diện mỗi khi chuyển sang chế độ Tự động.
  useEffect(() => {
    if (mode === 'auto') {
      readyStreakRef.current = 0;
      waitingClearRef.current = false;
      setReadyStreak(0);
      setAutoState('searching');
    }
  }, [mode]);

  // Vòng lặp kiểm tra nhanh (Giai đoạn 3).
  useEffect(() => {
    if (mode !== 'auto' || error || starting || pendingCapture) return;

    const timer = window.setInterval(async () => {
      if (checkingRef.current) return;
      const video = videoRef.current;
      if (!video || video.videoWidth === 0) return;

      checkingRef.current = true;
      try {
        const scale = QUICK_CHECK_WIDTH / video.videoWidth;
        const w = QUICK_CHECK_WIDTH;
        const h = Math.max(1, Math.round(video.videoHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);

        const blob: Blob | null = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.7));
        if (!blob) return;

        const form = new FormData();
        form.append('image', blob, 'quick.jpg');
        const res = await fetch('/api/v1/omr/quick-check', { method: 'POST', body: form });
        if (!res.ok) return;
        const data = (await res.json()) as { detected: boolean; ready: boolean };

        if (!data.detected) {
          // Không thấy phiếu trong khung — coi như đã "lấy phiếu cũ ra",
          // cho phép lần chụp tự động tiếp theo.
          waitingClearRef.current = false;
          readyStreakRef.current = 0;
          setReadyStreak(0);
          setAutoState('searching');
          return;
        }

        if (waitingClearRef.current) {
          // Vẫn là phiếu vừa chụp xong, chưa rời khung — không tính streak.
          setAutoState('clearing');
          return;
        }

        if (data.ready) {
          readyStreakRef.current += 1;
          setReadyStreak(readyStreakRef.current);
          setAutoState('holding');
          if (readyStreakRef.current >= READY_STREAK_NEEDED) {
            readyStreakRef.current = 0;
            setReadyStreak(0);
            waitingClearRef.current = true;
            captureFullRes();
          }
        } else {
          readyStreakRef.current = 0;
          setReadyStreak(0);
          setAutoState('holding');
        }
      } catch {
        // Bỏ qua lỗi mạng ở 1 lần kiểm tra — thử lại ở lần tiếp theo.
      } finally {
        checkingRef.current = false;
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [mode, error, starting, pendingCapture, captureFullRes]);

  // Dọn URL preview khi đóng modal giữa lúc đang xem trước ảnh.
  // (pendingCaptureRef được khai báo + đồng bộ ở gần đầu component.)
  useEffect(() => {
    return () => {
      if (pendingCaptureRef.current) URL.revokeObjectURL(pendingCaptureRef.current.url);
    };
  }, []);

  const ringColor =
    mode !== 'auto' ? 'transparent'
    : autoState === 'clearing' ? '#3B82F6'
    : autoState === 'holding'  ? '#F59E0B'
    : '#9CA3AF';

  const statusText =
    mode !== 'auto' ? null
    : autoState === 'clearing' ? 'Đã chụp ✓ — nhấc phiếu ra để chụp phiếu tiếp theo'
    : autoState === 'holding'  ? `Giữ yên… (${readyStreak}/${READY_STREAK_NEEDED})`
    : 'Đưa phiếu vào khung, thấy rõ cả 4 góc';

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: '#000',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px', background: 'rgba(0,0,0,0.55)', color: '#fff',
        position: 'relative', zIndex: 2, flexWrap: 'wrap', gap: 10,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Camera size={16} />
          Chụp ảnh phiếu
          {shotCount > 0 && (
            <span style={{ background: '#C8102E', borderRadius: 9999, padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>
              Đã chụp {shotCount}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {!error && (
            <div style={{ display: 'inline-flex', background: 'rgba(255,255,255,0.12)', borderRadius: 9999, padding: 3, gap: 2 }}>
              <button
                onClick={() => setMode('auto')}
                style={{
                  border: 'none', borderRadius: 9999, padding: '6px 12px', fontSize: 12, fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 5,
                  background: mode === 'auto' ? '#C8102E' : 'transparent',
                  color: '#fff',
                }}
              >
                <Zap size={12} /> Tự động
              </button>
              <button
                onClick={() => setMode('manual')}
                style={{
                  border: 'none', borderRadius: 9999, padding: '6px 12px', fontSize: 12, fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 5,
                  background: mode === 'manual' ? '#C8102E' : 'transparent',
                  color: '#fff',
                }}
              >
                <Hand size={12} /> Thủ công
              </button>
            </div>
          )}
          <button
            onClick={handleClose}
            style={{ border: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 9999, width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', cursor: 'pointer', flexShrink: 0 }}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Video / error / preview area */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {error ? (
          <div style={{ maxWidth: 420, textAlign: 'center', color: '#fff', padding: 24 }}>
            <div style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 18 }}>{error}</div>
            <Button variant="secondary" onClick={handleClose}>Đóng</Button>
          </div>
        ) : (
          <>
            {/* 2026-08-04: <video> PHẢI luôn nằm trong DOM, không được gỡ ra
                lúc pendingCapture — trước đó dùng ternary ẩn hẳn <video> đi
                khi xem trước ảnh, khiến React huỷ hẳn element này; lúc "Chụp
                lại" quay về thì React tạo ra 1 <video> MỚI hoàn toàn, nhưng
                effect gán srcObject = stream chỉ chạy đúng 1 lần lúc mount
                đầu tiên (deps rỗng) — element mới không có gì để phát, ra
                màn hình đen, và videoWidth=0 khiến captureFullRes() cũng
                lặng lẽ không làm gì ("nút chụp không ấn được"). Giờ chỉ ẩn
                bằng cách phủ lớp preview lên TRÊN video (video vẫn chạy nền),
                không unmount nó. */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%', height: '100%', objectFit: 'contain', background: '#000',
                boxShadow: mode === 'auto' && !pendingCapture ? `inset 0 0 0 4px ${ringColor}` : undefined,
                transition: 'box-shadow 160ms',
              }}
            />
            {/* 2026-08-04: "chưa biết căn nnao" — khung 4 góc gợi ý tỉ lệ khổ
                A4 (chung cho cả 3 mẫu phiếu, cùng khổ giấy), thuần hình ảnh,
                KHÔNG phải điều kiện kỹ thuật — việc thật sự quyết định "đã
                sẵn sàng chưa" vẫn do crop_on_markers (detect marker động ở
                BE) quyết định, để không bắt buộc người dùng phải căn khớp
                pixel-chính-xác (mỗi người cầm máy 1 khoảng cách/góc khác nhau). */}
            {!starting && !pendingCapture && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <div style={{
                  width: 'min(72vw, 51vh)',
                  aspectRatio: '1 / 1.4142',
                  position: 'relative',
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                  borderRadius: 6,
                }}>
                  {([
                    { top: -2, left: -2, borderWidth: '4px 0 0 4px', borderTopLeftRadius: 6 },
                    { top: -2, right: -2, borderWidth: '4px 4px 0 0', borderTopRightRadius: 6 },
                    { bottom: -2, left: -2, borderWidth: '0 0 4px 4px', borderBottomLeftRadius: 6 },
                    { bottom: -2, right: -2, borderWidth: '0 4px 4px 0', borderBottomRightRadius: 6 },
                  ] as const).map((s, i) => (
                    <div
                      key={i}
                      style={{
                        position: 'absolute', width: 26, height: 26,
                        borderColor: 'rgba(255,255,255,0.85)', borderStyle: 'solid',
                        ...s,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
            {starting && (
              <div style={{ position: 'absolute', color: '#fff', fontSize: 13, opacity: 0.8 }}>
                Đang mở camera…
              </div>
            )}
            {flash && (
              <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: 0.55, pointerEvents: 'none' }} />
            )}
            {statusText && !starting && !pendingCapture && (
              <div style={{
                position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 13, fontWeight: 600,
                padding: '7px 16px', borderRadius: 9999, whiteSpace: 'nowrap',
              }}>
                {statusText}
              </div>
            )}

            {/* Xem lại ảnh — phủ lớp mờ đục lên trên video (video vẫn chạy
                nền, không unmount) cho tới khi bấm "Dùng ảnh này"/"Chụp lại". */}
            {pendingCapture && (
              <div style={{ position: 'absolute', inset: 0, background: '#000', display: 'flex', flexDirection: 'column' }}>
                <img
                  src={pendingCapture.url}
                  alt="Ảnh vừa chụp"
                  style={{ flex: 1, width: '100%', minHeight: 0, objectFit: 'contain' }}
                />
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
                  padding: '18px 18px calc(18px + env(safe-area-inset-bottom))',
                }}>
                  <Button variant="secondary" size="lg" icon={<RotateCcw size={16} />} onClick={retakeCapture}>
                    Chụp lại
                  </Button>
                  <Button variant="primary" size="lg" icon={<Check size={16} />} onClick={confirmCapture}>
                    Dùng ảnh này
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom controls */}
      {!error && !pendingCapture && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28,
          padding: '20px 18px calc(20px + env(safe-area-inset-bottom))',
          background: 'rgba(0,0,0,0.55)', position: 'relative', zIndex: 2,
        }}>
          <button
            onClick={captureFullRes}
            disabled={starting}
            aria-label="Chụp"
            title={mode === 'auto' ? 'Chụp thủ công (dự phòng nếu chế độ tự động không bắt được)' : 'Chụp'}
            style={{
              width: 68, height: 68, borderRadius: '50%',
              background: '#fff', border: '4px solid rgba(255,255,255,0.35)',
              cursor: starting ? 'not-allowed' : 'pointer', opacity: starting ? 0.5 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span style={{ width: 54, height: 54, borderRadius: '50%', background: '#C8102E' }} />
          </button>
          <Button
            variant="secondary"
            icon={<Check size={15} />}
            onClick={handleClose}
            style={{ position: 'absolute', right: 18 }}
          >
            Xong ({shotCount})
          </Button>
        </div>
      )}

      {!error && !starting && !pendingCapture && (
        <div style={{ position: 'absolute', bottom: 96, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.75)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, pointerEvents: 'none' }}>
          <RotateCcw size={12} /> Chụp thẳng, đủ sáng, thấy rõ 4 góc phiếu
        </div>
      )}
    </div>
  );
}
