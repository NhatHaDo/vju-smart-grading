/**
 * QrAnswerPage.tsx — /qr?k=<token>: what a phone / iPad Camera opens from a
 * mã QR đáp án. No login: shows the đáp án and a button to download them as
 * Excel ("điện thoại, ipad, thiết bị khác quét thì phải ra file excel đáp án").
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Download } from 'lucide-react';
import AnswerKeyView from '../components/common/AnswerKeyView';
import { publicAnswerKey, publicAnswerKeyXlsxUrl, type PublicAnswerKey } from '../services/apiClient';

export default function QrAnswerPage() {
  const k = new URLSearchParams(useLocation().search).get('k') ?? '';
  const [data, setData] = useState<PublicAnswerKey | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!k) { setError('Thiếu mã QR'); return; }
    publicAnswerKey(k).then(setData).catch(e => setError((e as Error).message));
  }, [k]);

  const codes = data ? Object.keys(data.byMaDe).filter(Boolean).sort() : [];
  const count = data ? Object.keys(Object.values(data.byMaDe)[0] ?? {}).length : 0;

  return (
    <div style={{ minHeight: '100dvh', background: '#F3F4F6', fontFamily: 'inherit' }}>
      <div style={{ background: '#C8102E', color: '#fff', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src="/vju-logo-wide.png" alt="VJU" style={{ height: 30, background: '#fff', borderRadius: 6, padding: '2px 6px' }} />
        <div style={{ fontSize: 15, fontWeight: 700 }}>Đáp án</div>
      </div>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && <div style={{ background: '#fff', borderRadius: 14, padding: 16, color: '#C8102E', fontSize: 14 }}>⚠ {error}</div>}
        {!data && !error && <div style={{ color: '#9CA3AF', fontSize: 14, padding: 16 }}>Đang tải…</div>}
        {data && (
          <>
            <div style={{ background: '#fff', borderRadius: 14, padding: 16, border: '1px solid #EEE' }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#1E1E1E' }}>{data.title}</div>
              <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>
                {codes.length ? `${codes.length} mã đề (${codes.join(', ')}) · ` : ''}{count} câu
                {data.template.name ? ` · ${data.template.name}` : ''}
              </div>
              <a href={publicAnswerKeyXlsxUrl(k)} download
                style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 8, background: '#C8102E', color: '#fff',
                  borderRadius: 9999, padding: '10px 18px', fontWeight: 700, fontSize: 14, textDecoration: 'none' }}>
                <Download size={16} /> Tải file Excel đáp án
              </a>
            </div>
            <div style={{ background: '#fff', borderRadius: 14, padding: 16, border: '1px solid #EEE' }}>
              <AnswerKeyView data={data} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
