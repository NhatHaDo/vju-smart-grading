/**
 * LandingPage.tsx — VJU Smart Grading public landing page
 * Adapted from vju-omr-web LandingPage.jsx (UI only, no auth logic).
 * 2026-09-30: copy updated to today's app (ngân hàng câu hỏi, trộn đề, chấm nhanh).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import FlowerCanvas from '../components/decor/FlowerCanvas';
import './LandingPage.css';

/* ── data ───────────────────────────────────────────────────── */
const features = [
  { title: 'Ngân hàng câu hỏi',          text: 'Trắc nghiệm, Đúng/Sai, trả lời ngắn. Import từ Word hoặc Moodle, chia sẻ cho đồng nghiệp.', icon: 'bank',    tone: 'red'   },
  { title: 'Trộn đề nhiều mã',           text: 'Trộn từ file đề hoặc từ ngân hàng, đảo câu và đáp án, xuất từng mã đề và đáp án ra Word.', icon: 'shuffle', tone: 'green' },
  { title: 'Đáp án tự điền theo mã đề',  text: 'Gắn bộ đề vào kỳ thi, đáp án của từng mã đề được điền sẵn khi chấm, không phải nhập tay.', icon: 'key',     tone: 'red'   },
  { title: 'Chấm hàng loạt',             text: 'Tải lên ảnh hoặc PDF phiếu thi (JPG, PNG, HEIC, PDF), chọn cả thư mục, chấm trong vài giây.', icon: 'scan',    tone: 'green' },
  { title: 'Chấm nhanh bằng điện thoại', text: 'Giơ phiếu trước camera là có điểm ngay, tự nhận ra mã đề để dùng đúng đáp án.',             icon: 'camera',  tone: 'red'   },
  { title: 'Kết quả và thống kê',        text: 'Kiểm tra phiếu tô mờ, tô nhiều ô, sửa trực tiếp, xuất bảng điểm Excel theo từng kỳ thi.',    icon: 'chart',   tone: 'green' },
];

const steps = [
  { label: 'BƯỚC 01', title: 'Soạn câu hỏi',           text: 'Thêm câu hỏi vào ngân hàng hoặc dùng luôn file đề Word, Moodle có sẵn.',            icon: 'bank',    tone: 'red'   },
  { label: 'BƯỚC 02', title: 'Trộn đề và in',           text: 'Chọn số câu, số mã đề, tải về các mã đề và đáp án để in cho sinh viên.',          icon: 'shuffle', tone: 'green' },
  { label: 'BƯỚC 03', title: 'Chấm phiếu',              text: 'Tải ảnh phiếu lên hoặc dùng camera điện thoại, đáp án theo mã đề điền tự động.',   icon: 'camera',  tone: 'red'   },
  { label: 'BƯỚC 04', title: 'Xem kết quả, xuất Excel', text: 'Xem điểm từng phiếu, kiểm tra các phiếu cần xem lại và xuất bảng điểm.',          icon: 'check',   tone: 'green' },
];

type IconName = 'scan'|'bolt'|'chart'|'review'|'shield'|'download'|'upload'|'check'|'bank'|'shuffle'|'key'|'camera';
const iconPaths: Record<IconName, React.ReactNode> = {
  scan:     <><path d="M7 3H5a2 2 0 0 0-2 2v2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 12h8"/></>,
  bolt:     <path d="M13 2 4 14h7l-1 8 10-13h-7l0-7Z"/>,
  chart:    <><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16V9"/><path d="M12 16V6"/><path d="M16 16v-4"/></>,
  review:   <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="m9 15 2 2 4-5"/><circle cx="8" cy="10" r="1"/></>,
  shield:   <><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/><path d="m9 12 2 2 4-5"/></>,
  download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
  upload:   <><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 21h14"/></>,
  check:    <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
  bank:     <><path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/></>,
  shuffle:  <><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/></>,
  key:      <><circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></>,
  camera:   <><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3"/></>,
};
function FIcon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{iconPaths[name as IconName]}</svg>;
}

/* ── logo mark ───────────────────────────────────────────────── */
function LogoMark({ inverted = false, size = 'md' }: { inverted?: boolean; size?: 'sm'|'md' }) {
  const h = size === 'sm' ? 36 : 44;

  if (inverted) {
    /* ── trên nền đỏ / tối: logo ngang → invert thành trắng ── */
    const imgH = size === 'sm' ? 36 : 46;
    return (
      <img
        src="/vju-logo-wide.png"
        alt="VJU"
        style={{
          height: imgH,
          width: 'auto',
          maxWidth: 200,
          objectFit: 'contain',
          display: 'block',
          filter: 'brightness(0) invert(1)',
        }}
      />
    );
  }

  /* ── trên nền trắng / sáng: logo ngang có màu ── */
  return (
    <img
      src="/vju-logo-wide.png"
      alt="VJU"
      style={{
        height: h,
        width: 'auto',
        maxWidth: 180,
        objectFit: 'contain',
        display: 'block',
      }}
    />
  );
}

/* ── main ────────────────────────────────────────────────────── */
export default function LandingPage() {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 24);
    fn();
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  /* ── IntersectionObserver: scroll reveal ── */
  useEffect(() => {
    const selectors = '.reveal, .reveal-group, .stat-in';
    const els = document.querySelectorAll<HTMLElement>(selectors);
    const io = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (e.isIntersecting) {
          (e.target as HTMLElement).classList.add('is-visible');
          io.unobserve(e.target);
        }
      }),
      { threshold: 0.12 }
    );
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    setMenuOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const goLogin  = () => { setMenuOpen(false); navigate('/login'); };
  const goApp    = () => { setMenuOpen(false); navigate('/app'); };

  return (
    <div className="landing-page">

      {/* ── Nav ── */}
      <header className={`landing-nav ${scrolled ? 'is-scrolled' : ''}`}>
        <div className="landing-nav-inner">
          <button className="landing-logo-button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <LogoMark inverted={!scrolled} />
          </button>
          <nav className="landing-nav-links">
            <button onClick={() => scrollTo('features')}>Tính năng</button>
            <button onClick={() => scrollTo('how-it-works')}>Cách hoạt động</button>
            <button onClick={() => scrollTo('about')}>Về VJU</button>
            <button onClick={goLogin}>Đăng nhập</button>
            <button className="landing-btn landing-btn-primary landing-nav-cta" onClick={goApp}>Vào hệ thống</button>
          </nav>
          <button className="landing-menu-button" onClick={() => setMenuOpen(true)}>☰</button>
        </div>
      </header>

      {menuOpen && (
        <div className="landing-mobile-menu">
          <button className="landing-mobile-close" onClick={() => setMenuOpen(false)}>×</button>
          <LogoMark />
          <button onClick={() => scrollTo('features')}>Tính năng</button>
          <button onClick={() => scrollTo('how-it-works')}>Cách hoạt động</button>
          <button onClick={() => scrollTo('about')}>Về VJU</button>
          <button onClick={goLogin}>Đăng nhập</button>
          <button className="landing-btn landing-btn-primary landing-nav-cta" onClick={goApp}>Vào hệ thống</button>
        </div>
      )}

      <main>

        {/* ── Hero ── */}
        <section className="landing-hero">
          <div className="landing-hero-pattern" />
          {/* FlowerCanvas thay thế FloatingFlowersBackground */}
          <FlowerCanvas variant="landing" drawBg={false} opacity={0.85}
            style={{ zIndex: 0, pointerEvents: 'none' }} />

          <div className="landing-hero-inner" style={{ position: 'relative', zIndex: 1 }}>
            <div className="landing-hero-copy">
              <div className="landing-badge">⚡ VJU Smart Grading System</div>
              <h1>Ra đề, trộn đề và chấm phiếu tự động</h1>
              <p>
                Hệ thống khảo thí trắc nghiệm của Trường Đại học Việt Nhật: soạn và trộn đề nhiều mã,
                chấm phiếu bằng ảnh hoặc camera điện thoại với đáp án tự điền theo mã đề, xuất kết quả Excel.
              </p>
              <div className="landing-pills">
                <span>Ngân hàng câu hỏi và trộn đề</span>
                <span>Chấm bằng ảnh hoặc camera</span>
                <span>Xuất bảng điểm Excel</span>
              </div>
              <div className="landing-hero-actions">
                <button className="landing-btn landing-btn-secondary landing-primary" onClick={goApp}>
                  Vào hệ thống <span>›</span>
                </button>
                <button className="landing-btn landing-btn-ghost landing-secondary" onClick={() => scrollTo('showcase')}>
                  Xem demo
                </button>
              </div>
            </div>

            {/* Mock card */}
            <div className="landing-demo-card">
              <div className="landing-demo-top">
                <LogoMark inverted size="sm" />
                <span>Dashboard</span>
              </div>
              <div className="landing-demo-stats">
                <div><strong>12</strong><span>Kỳ thi</span></div>
                <div><strong>4</strong><span>Mã đề</span></div>
                <div><strong>2,847</strong><span>Phiếu đã chấm</span></div>
              </div>
              <div className="landing-demo-progress">
                <div><span>Giữa kì Tin học đại cương</span><b>87%</b></div>
                {/* animated fill bar */}
                <i className="demo-bar-fill" />
              </div>
              <div className="landing-demo-rows">
                <div><span>Nguyễn Văn A</span><strong>8.5</strong></div>
                <div><span>Trần Thị B</span><strong>7.0</strong></div>
                <div><span>Lê Văn C</span><strong>9.5</strong></div>
              </div>
              <div className="landing-demo-float">✓ Chấm xong 42 phiếu</div>
            </div>
          </div>
        </section>

        {/* ── Stats ── */}
        <section className="landing-stats reveal-group">
          <div><strong>3</strong><span>Loại câu hỏi</span></div>
          <div><strong>24</strong><span>Mã đề mỗi lần trộn</span></div>
          <div><strong>&lt;3s</strong><span>Mỗi phiếu</span></div>
          <div><strong>7</strong><span>Định dạng ảnh, PDF</span></div>
        </section>

        {/* ── Features ── */}
        <section id="features" className="landing-section">
          <div className="landing-section-heading reveal">
            <span>Tính năng nổi bật</span>
            <h2>Mọi thứ cho một <em>kỳ thi trắc nghiệm</em></h2>
            <p>Soạn câu hỏi, trộn đề, chấm phiếu, xem kết quả: cả quy trình trong một hệ thống.</p>
          </div>
          <div className="landing-feature-grid reveal-group">
            {features.map(f => (
              <article key={f.title} className="landing-card landing-feature-card">
                <div className={`landing-card-icon landing-feature-icon is-${f.tone}`}><FIcon name={f.icon} /></div>
                <h3 className="landing-card-title">{f.title}</h3>
                <p className="landing-card-text">{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── Showcase — image cards ── */}
        <section id="showcase" style={{ padding: '0 24px 72px', maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 20 }}>
            {[
              {
                img: 'https://images.unsplash.com/photo-1612198188060-c7c2a3b66eae?w=900&q=80',
                tag: 'TRỘN ĐỀ',
                title: 'Trộn đề từ ngân hàng câu hỏi',
                desc: 'Bốc ngẫu nhiên câu hỏi, đảo câu và đáp án cho từng mã đề, tải về file Word để in.',
              },
              {
                img: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=900&q=80',
                tag: 'CHẤM PHIẾU',
                title: 'Chấm phiếu và thống kê tức thì',
                desc: 'Nhận dạng từng ô tô trên phiếu, chấm theo đúng mã đề, thống kê điểm và xuất Excel.',
              },
            ].map((item, i) => (
              <div
                key={i}
                className="landing-img-card"
                style={{ position: 'relative', borderRadius: 20, overflow: 'hidden',
                  background: '#e5e7eb', aspectRatio: '16/9' }}
              >
                {/* Ảnh nền */}
                <img
                  src={item.img}
                  alt={item.title}
                  className="landing-img-card-img"
                  style={{ width: '100%', height: '100%', objectFit: 'cover',
                    display: 'block', transition: 'transform 700ms ease' }}
                />
                {/* Gradient overlay từ dưới lên */}
                <div style={{
                  position: 'absolute', inset: 0,
                  background: 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.20) 50%, transparent 100%)',
                }} />
                {/* Text overlay */}
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0, padding: '24px',
                }}>
                  <span style={{
                    display: 'inline-block', marginBottom: 10,
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.2em',
                    textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)',
                    border: '1px solid rgba(255,255,255,0.25)',
                    padding: '4px 10px', borderRadius: 999,
                  }}>{item.tag}</span>
                  <h3 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 800,
                    color: '#fff', lineHeight: 1.25 }}>{item.title}</h3>
                  <p style={{ margin: 0, fontSize: 14, color: 'rgba(255,255,255,0.65)',
                    lineHeight: 1.6 }}>{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── How it works ── */}
        <section id="how-it-works" className="landing-section">
          <div className="landing-section-heading reveal">
            <span>CÁCH HOẠT ĐỘNG</span>
            <h2>Chỉ <em>4 bước</em> đơn giản</h2>
            <p>Không cần cài đặt. Dùng ngay trên trình duyệt máy tính hoặc điện thoại.</p>
          </div>
          <div className="landing-steps reveal-group">
            {steps.map(s => (
              <article key={s.title} className={`landing-step-item is-${s.tone}`}>
                <div className="landing-step-circle"><FIcon name={s.icon} /></div>
                <span className="landing-step-label">{s.label}</span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── About ── */}
        <section id="about" className="landing-about">
          <div>
            <span>Vietnam Japan University</span>
            <h2>Hỗ trợ chuyển đổi số trong công tác khảo thí</h2>
          </div>
          <p>
            Hệ thống được phát triển theo định hướng hỗ trợ Trường Đại học Việt Nhật quản lý kỳ thi,
            giảm thao tác thủ công, tăng tính minh bạch và giúp giảng viên kiểm tra lại các trường hợp không chắc chắn.
          </p>
        </section>

        {/* ── CTA ── */}
        <section className="landing-cta" style={{ position: 'relative', overflow: 'hidden' }}>
          <FlowerCanvas variant="cta" drawBg={false} opacity={0.5}
            style={{ zIndex: 0, borderRadius: 'inherit' }} />
          <div style={{ position: 'relative', zIndex: 1 }}>
            {/* Seal tròn centered — màu gốc trong vòng trắng */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <img src="/vju-seal.png" alt="VJU"
                style={{ width: 72, height: 72, objectFit: 'contain', display: 'block' }} />
            </div>
            <h2>Sẵn sàng chấm phiếu thông minh hơn?</h2>
            <p>Tiết kiệm thời gian ra đề và chấm bài, giảm sai sót thủ công, quản lý kết quả tập trung.</p>
            <div>
              <button className="landing-btn landing-btn-secondary landing-primary is-light" onClick={goApp}>
                Bắt đầu ngay hôm nay <span>›</span>
              </button>
              <button className="landing-btn landing-btn-ghost landing-text-button" onClick={() => scrollTo('features')}>
                Tìm hiểu thêm <span>→</span>
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="landing-footer">
        <div className="landing-footer-grid">
          <div>
            <LogoMark inverted />
            <p>Hệ thống chấm phiếu thi trắc nghiệm tự động phát triển bởi Trường Đại học Việt Nhật.</p>
            <ul>
              <li>Lưu Hữu Phước, Cầu Giấy, Hà Nội</li>
              <li>(024) 7306 6001</li>
              <li>info@vju.ac.vn</li>
            </ul>
          </div>
          <div>
            <h4>Hệ thống</h4>
            <button onClick={goLogin}>Ngân hàng câu hỏi</button>
            <button onClick={goLogin}>Trộn đề</button>
            <button onClick={goLogin}>Upload &amp; Chấm phiếu</button>
            <button onClick={goLogin}>Chấm nhanh</button>
            <button onClick={goLogin}>Kết quả &amp; Excel</button>
          </div>
          <div>
            <h4>Hỗ trợ</h4>
            <button onClick={() => scrollTo('how-it-works')}>Hướng dẫn sử dụng</button>
            <button onClick={() => scrollTo('features')}>Câu hỏi thường gặp</button>
            <button onClick={() => scrollTo('about')}>Liên hệ kỹ thuật</button>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <span>© 2026 VJU Smart Grading · Vietnam Japan University. All rights reserved.</span>
          <span className="landing-jp">日越大学</span>
        </div>
      </footer>
    </div>
  );
}
