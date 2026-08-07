/**
 * QuickGradePage.tsx — "Chấm nhanh liên tục" (2026-08-05)
 *
 * Yêu cầu gốc: "t muốn web của t có chức năng chấm nhanh... hiện điểm ngay
 * sau khi quét; hỗ trợ nhiều mã đề; có thể chấm tự động liên tiếp nhiều
 * phiếu; thời gian khoảng vài giây cho mỗi phiếu" (đối chiếu app chamthi.com).
 *
 * Khác với luồng chụp cũ (SheetReviewPage → CameraCaptureModal → AnswerKeyPage
 * → "Chấm ngay" chấm cả loạt cùng lúc), trang này:
 *   1. Dùng NGAY đáp án/mẫu phiếu đang active (đã lưu ở Answer Key) — không
 *      phải chọn lại mỗi lần.
 *   2. Camera tự nhận diện phiếu (tái dùng /omr/quick-check, cùng cơ chế
 *      "giữ yên 3 lần liên tiếp" như CameraCaptureModal) rồi CHẤM NGAY —
 *      không dừng lại ở bước xem trước/xác nhận ảnh (bỏ hẳn theo lựa chọn
 *      của người dùng, ưu tiên tốc độ).
 *   3. Điểm hiện ra ngay dưới dạng banner nổi trên khung hình — KHÔNG chặn
 *      camera — để người dùng tráo phiếu tiếp theo ngay trong lúc xem điểm.
 *   4. Kết thúc phiên → "Xong" điều hướng sang /app/results với đúng
 *      BatchGradeState mà trang đó đã biết cách tự lưu xuống DB (tái dùng
 *      logic saveBatch có sẵn ở ResultsPage, không viết lại).
 *
 * Cố tình là 1 trang HOÀN TOÀN RIÊNG — không sửa CameraCaptureModal.tsx hay
 * luồng Upload/Answer Key hiện có, theo đúng phạm vvi đã chọn.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, X, Hand, Camera as CameraIcon, ArrowLeft, AlertTriangle, CheckCircle2, ListChecks, Settings2 } from 'lucide-react';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import PageHeader from '../components/layout/PageHeader';
import {
  loadAnswerKey,
  loadLastUsedTemplate,
  isMultiMaDe,
  TEMPLATE_VARIANT_LABEL,
  type TemplateVariant,
  type OmrGradeResult,
  type BatchGradeState,
  type AnswerKeyStore,
  type LastUsedTemplate,
} from '../types/grading';

// Đường dẫn TƯƠNG ĐỐI, không phải VITE_API_BASE tuyệt đối — giống lý do đã
// ghi trong CameraCaptureModal.tsx: test qua cloudflared trên điện thoại thì
// "localhost" tuyệt đối trỏ nhầm vào chính điện thoại. Trang này luôn dùng
// camera nên luôn cần đường dẫn tương đối qua đúng proxy /api.
const GRADE_URL      = '/api/v1/omr/debug-grade';
const QUICK_CHECK_URL = '/api/v1/omr/quick-check';

const POLL_INTERVAL_MS   = 450;
const READY_STREAK_NEEDED = 3;
const QUICK_CHECK_WIDTH   = 480;
/** Banner điểm tự ẩn sau chừng này nếu không có kết quả mới đè lên. */
const RESULT_BANNER_MS = 4000;

type AutoState = 'searching' | 'holding' | 'clearing';

function buildAnswerKeyPayload(store: AnswerKeyStore): Record<string, unknown> | null {
  if (isMultiMaDe(store)) {
    return {
      byMaDe: Object.fromEntries(
        Object.entries(store.byMaDe ?? {}).map(([maDe, set]) => [maDe, set.answers]),
      ),
      default: store.answers,
    };
  }
  return store.answers && Object.keys(store.answers).length > 0 ? store.answers : null;
}

function scorePercent(score: OmrGradeResult['score']): number | null {
  if (score.total == null || score.max == null || score.max <= 0) return null;
  return Math.round((score.total / score.max) * 100);
}

// Quy đổi điểm thang 10 (chuẩn phổ biến ở VN: điểm/điểm tối đa × 10), làm
// tròn 2 chữ số thập phân — hệ thống chưa có sẵn cột "điểm thang 10" nào
// khác để tái dùng (đã rà lại backend/frontend, không có công thức riêng),
// nên tính trực tiếp từ total/max giống hệt %  ở trên, chỉ khác đơn vị.
function scoreOn10(score: OmrGradeResult['score']): number | null {
  if (score.total == null || score.max == null || score.max <= 0) return null;
  return Math.round((score.total / score.max) * 10 * 100) / 100;
}

// Đường dẫn ảnh debug backend trả về (VD: "outputs/debug/xxx_overlay_all.jpg")
// cần quy về TƯƠNG ĐỐI (giống GRADE_URL/QUICK_CHECK_URL ở trên) — không prefix
// VITE_API_BASE tuyệt đối, để còn chạy đúng qua cloudflared trên điện thoại.
function resolveOverlayUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  const norm = path.replace(/\\/g, '/');
  const idx = Math.max(norm.lastIndexOf('outputs/'), norm.lastIndexOf('uploads/'));
  const relative = idx >= 0 ? norm.slice(idx) : norm.replace(/^\//, '');
  return `/${relative}`;
}

// ── Setup screen (chọn xong đáp án đang dùng, bấm Bắt đầu) ─────────────────

function SetupScreen({
  store, tpl, variant, setVariant, onStart,
}: {
  store: AnswerKeyStore | null;
  tpl: LastUsedTemplate | null;
  variant: TemplateVariant;
  setVariant: (v: TemplateVariant) => void;
  onStart: () => void;
}) {
  const navigate = useNavigate();
  const mode = tpl?.mode ?? 'vju';
  const hasAnswers = !!store && (
    Object.keys(store.answers ?? {}).length > 0 || isMultiMaDe(store)
  );
  const questionCount = store ? Object.keys(store.answers ?? {}).length : 0;
  const maDeCount = store?.byMaDe ? Object.keys(store.byMaDe).length : 0;
  const templateLabel = mode === 'custom'
    ? (tpl?.name ?? 'Custom template')
    : TEMPLATE_VARIANT_LABEL[variant];

  return (
    <div style={{ padding: 24, maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: '#FEECEC', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Zap size={20} color="#C8102E" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1E1E1E' }}>Đáp án đang dùng</div>
            <div style={{ fontSize: 12, color: '#6B7280' }}>Chấm nhanh dùng ngay đáp án đã lưu ở Answer Key — không chọn lại.</div>
          </div>
        </div>

        {!hasAnswers ? (
          <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AlertTriangle size={16} color="#C2410C" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, color: '#9A3412', lineHeight: 1.5 }}>
              Chưa có đáp án nào được lưu. Vào <strong>Answer Key</strong> nhập đáp án trước, quay lại đây sẽ dùng được ngay.
            </div>
          </div>
        ) : (
          <div style={{ background: '#F9FAFB', border: '1px solid #EEF0F2', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 13, color: '#374151' }}>
              <strong>{templateLabel}</strong> — {questionCount} câu đã có đáp án
              {maDeCount > 0 && <> · {maDeCount} mã đề</>}
            </div>
          </div>
        )}

        {mode === 'vju' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: '#6B7280', fontWeight: 600 }}>Mẫu phiếu VJU:</span>
            <div style={{ display: 'inline-flex', background: '#F3F4F6', borderRadius: 9999, padding: 3, gap: 2 }}>
              {(['sbd4', 'sbd8'] as TemplateVariant[]).map(v => (
                <button
                  key={v}
                  onClick={() => setVariant(v)}
                  style={{
                    border: 'none', borderRadius: 9999, padding: '6px 12px', fontSize: 12, fontWeight: 700,
                    cursor: 'pointer', fontFamily: 'inherit',
                    background: variant === v ? '#C8102E' : 'transparent',
                    color: variant === v ? '#fff' : '#374151',
                  }}
                >
                  {v === 'sbd4' ? 'SBD 4 số' : 'SBD 8 số'}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button variant="secondary" icon={<Settings2 size={15} />} onClick={() => navigate('/app/answer-key')}>
            Đổi đáp án / mẫu phiếu
          </Button>
        </div>
      </Card>

      <Button
        variant="primary"
        size="lg"
        icon={<CameraIcon size={18} />}
        disabled={!hasAnswers}
        onClick={onStart}
        style={{ width: '100%' }}
      >
        Bắt đầu chấm nhanh
      </Button>

      <div style={{ fontSize: 12, color: '#9CA3AF', textAlign: 'center', lineHeight: 1.6 }}>
        Giơ máy lên, camera tự nhận diện phiếu và chấm ngay — không cần bấm chụp hay xác nhận ảnh.
        Điểm hiện ra trong 1-2 giây, tráo phiếu tiếp theo là chấm luôn.
      </div>
    </div>
  );
}

// ── Trang chính ─────────────────────────────────────────────────────────────

export default function QuickGradePage() {
  const navigate = useNavigate();

  const [store, setStore] = useState<AnswerKeyStore | null>(null);
  const [tpl,   setTpl]   = useState<LastUsedTemplate | null>(null);
  const [variant, setVariant] = useState<TemplateVariant>('sbd8');
  const [sessionActive, setSessionActive] = useState(false);

  useEffect(() => {
    setStore(loadAnswerKey());
    setTpl(loadLastUsedTemplate());
  }, []);

  // Re-đọc mỗi khi quay lại trang (ví dụ sau khi qua Answer Key sửa rồi bấm Back).
  useEffect(() => {
    const onFocus = () => { setStore(loadAnswerKey()); setTpl(loadLastUsedTemplate()); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (!sessionActive) {
    return (
      <>
        <PageHeader
          title="Chấm nhanh liên tục"
          subtitle="Giơ máy lên là tự động chấm — hiện điểm ngay, không cần thao tác thêm."
          actions={<Button variant="secondary" icon={<ArrowLeft size={15} />} onClick={() => navigate('/app/upload')}>Về Upload &amp; Chấm</Button>}
        />
        <SetupScreen
          store={store}
          tpl={tpl}
          variant={variant}
          setVariant={setVariant}
          onStart={() => setSessionActive(true)}
        />
      </>
    );
  }

  return (
    <QuickGradeCamera
      store={store as AnswerKeyStore}
      tpl={tpl}
      variant={variant}
      onExit={(results) => {
        setSessionActive(false);
        if (results.length === 0) return;
        const mode = tpl?.mode ?? 'vju';
        const batch: BatchGradeState = {
          templateVariant: variant,
          results,
          gradedAt: new Date().toISOString(),
          templateMode: mode,
          customTemplateId:   mode === 'custom' ? (tpl?.id ?? null) : null,
          customTemplateName: mode === 'custom' ? (tpl?.name ?? null) : null,
          templateSchema: null,
        };
        navigate('/app/results', { state: batch });
      }}
    />
  );
}

// ── Camera chấm liên tục ─────────────────────────────────────────────────────

function QuickGradeCamera({
  store, tpl, variant, onExit,
}: {
  store: AnswerKeyStore;
  tpl: LastUsedTemplate | null;
  variant: TemplateVariant;
  onExit: (results: OmrGradeResult[]) => void;
}) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [error,    setError]    = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [autoState, setAutoState] = useState<AutoState>('searching');
  const [readyStreak, setReadyStreak] = useState(0);
  const [grading,  setGrading]  = useState(false);
  const [lastResult, setLastResult] = useState<OmrGradeResult | null>(null);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [results,  setResults]  = useState<OmrGradeResult[]>([]);

  const checkingRef     = useRef(false);
  const waitingClearRef = useRef(false);
  const readyStreakRef  = useRef(0);
  const gradingRef      = useRef(false);
  const bannerTimerRef  = useRef<number | null>(null);
  const resultsRef      = useRef<OmrGradeResult[]>([]);
  resultsRef.current = results;

  const isCustom = tpl?.mode === 'custom';
  // useMemo — không phải chỉ để tối ưu: buildAnswerKeyPayload() trả về 1
  // object literal mới mỗi lần gọi. Nếu không memo theo `store` (props ổn
  // định, chỉ set 1 lần từ QuickGradePage), captureAndGrade bên dưới (deps
  // có answerKeyPayload) sẽ đổi identity ở MỌI lần render — mà QuickGradeCamera
  // re-render liên tục theo từng tick poll (readyStreak/autoState đổi mỗi
  // 450ms) — khiến effect vòng lặp nhận diện bị huỷ + tạo lại interval liên
  // tục thay vì chạy ổn định 1 lần.
  const answerKeyPayload = useMemo(() => buildAnswerKeyPayload(store), [store]);

  // Trọng số điểm ở "Thang điểm" (Đúng/Sai/Bỏ trống + điểm riêng từng câu) —
  // dùng CHUNG 1 bộ (store.scoring cấp cao nhất, không phải riêng theo từng
  // mã đề) vì điểm số là thuộc tính của ĐỀ THI, không đổi theo mã đề — chỉ
  // có đáp án đúng mới đổi theo mã đề. Gửi kèm để backend tính điểm từng câu
  // (kể cả câu đã đặt điểm riêng) và in tóm tắt điểm từng Phần lên ảnh kết quả.
  const scoringPayload = useMemo(() => store.scoring, [store]);

  // ── Mở camera ──────────────────────────────────────────────────────────
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
      if (bannerTimerRef.current) window.clearTimeout(bannerTimerRef.current);
    };
  }, []);

  const handleExit = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    onExit(resultsRef.current);
  };

  const showResultBanner = useCallback((r: OmrGradeResult | null, err: string | null) => {
    setLastResult(r);
    setGradeError(err);
    if (bannerTimerRef.current) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => {
      setLastResult(null);
      setGradeError(null);
    }, RESULT_BANNER_MS);
  }, []);

  // Chụp full-res khung hình hiện tại rồi gửi CHẤM NGAY — không dừng lại ở
  // bước xem trước/xác nhận (bỏ hẳn theo lựa chọn ưu tiên tốc độ).
  const captureAndGrade = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || gradingRef.current) return;

    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async blob => {
      if (!blob) return;
      gradingRef.current = true;
      setGrading(true);
      try {
        const form = new FormData();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        form.append('image', blob, `camera_${ts}.jpg`);

        const templateParam = isCustom && tpl?.id != null
          ? `&template_id=${tpl.id}`
          : `&template_variant=${variant}`;
        const answerKeyParam = answerKeyPayload
          ? `&answer_key_json=${encodeURIComponent(JSON.stringify(answerKeyPayload))}`
          : '';
        const scoringParam = scoringPayload
          ? `&scoring_json=${encodeURIComponent(JSON.stringify(scoringPayload))}`
          : '';
        // full_debug=true — cần debug.overlay_all_path để hiện ảnh detect to
        // ngay trên màn hình Chấm nhanh (thay cho banner điểm nhỏ trước đây).
        const url = `${GRADE_URL}?mean_mode=circle_mask&full_debug=true&image_source=auto${templateParam}${answerKeyParam}${scoringParam}`;

        const res = await fetch(url, { method: 'POST', body: form });
        if (!res.ok) {
          const txt = await res.text();
          showResultBanner(null, `Lỗi chấm: HTTP ${res.status} — ${txt.slice(0, 160)}`);
        } else {
          const data = await res.json() as OmrGradeResult;
          setResults(rs => [...rs, data]);
          showResultBanner(data, null);
        }
      } catch (err) {
        showResultBanner(null, `Không gửi được ảnh lên chấm: ${(err as Error)?.message ?? 'lỗi mạng'}`);
      } finally {
        gradingRef.current = false;
        setGrading(false);
      }
    }, 'image/jpeg', 0.92);
  }, [isCustom, tpl?.id, variant, answerKeyPayload, scoringPayload, showResultBanner]);

  // Vòng lặp nhận diện — giữ nguyên cơ chế của CameraCaptureModal (giữ yên
  // READY_STREAK_NEEDED lần liên tiếp mới trigger), chỉ khác ở chỗ trigger
  // ra là chấm ngay thay vì dừng lại chờ xác nhận.
  useEffect(() => {
    if (error || starting) return;

    const timer = window.setInterval(async () => {
      if (checkingRef.current || gradingRef.current) return;
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
        const res = await fetch(QUICK_CHECK_URL, { method: 'POST', body: form });
        if (!res.ok) return;
        const data = (await res.json()) as { detected: boolean; ready: boolean };

        if (!data.detected) {
          waitingClearRef.current = false;
          readyStreakRef.current = 0;
          setReadyStreak(0);
          setAutoState('searching');
          return;
        }

        if (waitingClearRef.current) {
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
            captureAndGrade();
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
  }, [error, starting, captureAndGrade]);

  const ringColor =
    autoState === 'clearing' ? '#3B82F6'
    : autoState === 'holding'  ? '#F59E0B'
    : '#9CA3AF';

  const statusText = grading
    ? 'Đang chấm…'
    : autoState === 'clearing' ? 'Đã chấm ✓ — nhấc phiếu ra để chấm phiếu tiếp theo'
    : autoState === 'holding'  ? `Giữ yên… (${readyStreak}/${READY_STREAK_NEEDED})`
    : 'Đưa phiếu vào khung, thấy rõ cả 4 góc';

  const avgPercent = (() => {
    const pcts = results.map(r => scorePercent(r.score)).filter((p): p is number => p != null);
    if (pcts.length === 0) return null;
    return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  })();

  // Ảnh detect to hiện ngay sau khi chấm — ưu tiên overlay chấm màu xanh/đỏ
  // (debug.overlay_all_path), nếu backend không trả (VD lỗi trước khi tới
  // bước overlay) thì rơi về ảnh đã căn chỉnh/cân bằng sáng.
  const overlayImgSrc = lastResult
    ? resolveOverlayUrl(lastResult.debug?.overlay_all_path ?? lastResult.debug?.aligned_image_path)
    : null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#000', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px', background: 'rgba(0,0,0,0.55)', color: '#fff',
        position: 'relative', zIndex: 3, flexWrap: 'wrap', gap: 10,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={16} />
          Chấm nhanh
          {results.length > 0 && (
            <span style={{ background: '#C8102E', borderRadius: 9999, padding: '2px 10px', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
              <ListChecks size={12} /> {results.length} phiếu{avgPercent != null && ` · TB ${avgPercent}%`}
            </span>
          )}
        </div>
        <button
          onClick={handleExit}
          style={{ border: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 9999, width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', cursor: 'pointer', flexShrink: 0 }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Video */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {error ? (
          <div style={{ maxWidth: 420, textAlign: 'center', color: '#fff', padding: 24 }}>
            <div style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 18 }}>{error}</div>
            <Button variant="secondary" onClick={handleExit}>Đóng</Button>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%', height: '100%', objectFit: 'contain', background: '#000',
                boxShadow: `inset 0 0 0 4px ${ringColor}`,
                transition: 'box-shadow 160ms',
              }}
            />
            {!starting && (
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
            {!starting && (
              <div style={{
                position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 13, fontWeight: 600,
                padding: '7px 16px', borderRadius: 9999, whiteSpace: 'nowrap',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                {grading && <span style={{ width: 12, height: 12, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />}
                {statusText}
              </div>
            )}

            {/* Kết quả chấm — ảnh detect to (đè lên khung camera, không chặn
                thao tác vì tự ẩn + tự chuyển tiếp sau vài giây, không cần bấm
                tiếp tục), thay hẳn banner nhỏ trước đây theo lựa chọn của
                người dùng. */}
            {(lastResult || gradeError) && (
              <div style={{
                position: 'absolute', inset: 10, zIndex: 5,
                background: gradeError ? 'rgba(153,27,27,0.95)' : 'rgba(10,10,12,0.96)',
                borderRadius: 16, padding: 14, color: '#fff',
                display: 'flex', flexDirection: 'column', gap: 10,
                boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
              }}>
                {gradeError ? (
                  <div style={{ margin: 'auto', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', fontSize: 14, lineHeight: 1.6, maxWidth: 420, textAlign: 'center' }}>
                    <AlertTriangle size={28} color="#FBBF24" />
                    <span>{gradeError}</span>
                  </div>
                ) : lastResult && (
                  <>
                    {/* Thanh điểm tóm tắt */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
                      {lastResult.score.total != null && lastResult.score.max != null ? (
                        <div style={{ textAlign: 'center', flexShrink: 0 }}>
                          {/* Điểm thang 10 — số điểm thật (tính điểm), màu đỏ
                              kiểu chấm bằng bút đỏ như trên phiếu giấy */}
                          <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: '#EF4444' }}>
                            {scoreOn10(lastResult.score)}
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                            {lastResult.score.total}/{lastResult.score.max} · {scorePercent(lastResult.score)}%
                          </div>
                        </div>
                      ) : (
                        <AlertTriangle size={22} color="#FBBF24" style={{ flexShrink: 0 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5 }}>
                        {lastResult.score.total != null ? (
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', opacity: 0.9 }}>
                            <span>Đúng {lastResult.score.correct}</span>
                            <span>Sai {lastResult.score.wrong}</span>
                            <span>Bỏ trống {lastResult.score.blank}</span>
                          </div>
                        ) : (
                          <div style={{ opacity: 0.9 }}>Không xác định được điểm — kiểm tra mã đề/đáp án đã khớp chưa.</div>
                        )}
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', opacity: 0.75, marginTop: 2 }}>
                          {lastResult.student_info?.sbd   && <span>SBD {lastResult.student_info.sbd}</span>}
                          {lastResult.student_info?.ma_de && <span>Mã đề {lastResult.student_info.ma_de}</span>}
                          {(lastResult.warnings?.length ?? 0) > 0 && (
                            <span style={{ color: '#FBBF24' }}>⚠ {lastResult.warnings!.length} câu cần xem lại</span>
                          )}
                        </div>
                      </div>
                      <CheckCircle2 size={20} color="#34D399" style={{ flexShrink: 0 }} />
                    </div>

                    {/* Ảnh detect to — overlay chấm màu xanh/đỏ trên phiếu đã căn chỉnh */}
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, overflow: 'hidden', background: '#000' }}>
                      {overlayImgSrc ? (
                        <img src={overlayImgSrc} alt="Kết quả nhận diện" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                      ) : (
                        <div style={{ fontSize: 12.5, opacity: 0.7, padding: 20, textAlign: 'center' }}>Không có ảnh chi tiết cho lần chấm này.</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom controls */}
      {!error && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28,
          padding: '20px 18px calc(20px + env(safe-area-inset-bottom))',
          background: 'rgba(0,0,0,0.55)', position: 'relative', zIndex: 2,
        }}>
          <button
            onClick={captureAndGrade}
            disabled={starting || grading}
            aria-label="Chụp và chấm ngay"
            title="Chụp và chấm ngay (dự phòng nếu chế độ tự động không bắt được)"
            style={{
              width: 68, height: 68, borderRadius: '50%',
              background: '#fff', border: '4px solid rgba(255,255,255,0.35)',
              cursor: (starting || grading) ? 'not-allowed' : 'pointer', opacity: (starting || grading) ? 0.5 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span style={{ width: 54, height: 54, borderRadius: '50%', background: '#C8102E' }} />
          </button>
          <Button
            variant="secondary"
            icon={<CheckCircle2 size={15} />}
            onClick={handleExit}
            style={{ position: 'absolute', right: 18 }}
          >
            Xong ({results.length})
          </Button>
        </div>
      )}

      {!error && !starting && (
        <div style={{ position: 'absolute', bottom: 96, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.75)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, pointerEvents: 'none' }}>
          <Hand size={12} /> Nút tròn = chấm thủ công dự phòng · để yên là tự động chấm liên tục
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
