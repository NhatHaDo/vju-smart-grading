/**
 * AnswerQrModal.tsx — mã QR đáp án, like the QM app's (qrda.chamthi.com).
 *
 *  - examId given: the kỳ thi's QR (answers of its bộ đề trộn, read live).
 *  - no examId: "Tạo QR đáp án từ file Excel" — pick the answer sheet, the
 *    Excel file(s) (same format as Answer Key → Xuất Excel / Tải Excel mẫu),
 *    the answers are kept on the server and the QR points to them.
 *
 * Either QR is scanned in Chấm nhanh → Quét mã QR / Ảnh QR.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileUp, QrCode } from 'lucide-react';
import { saveAs } from 'file-saver';
import Modal from '../modals/Modal';
import Button from './Button';
import { customFormsApi, examPapersApi } from '../../services/apiClient';
import { buildSchemaFromDetail } from '../../utils/templateSchema';
import { buildAnswerKeySampleWorkbook, maDeFromFileName, parseAnswerKeyWorkbook } from '../../utils/answerKeyExcel';
import {
  DEFAULT_SCORING, PINNED_TEMPLATES, TEMPLATE_VARIANT_LABEL, VJU_PRESET_SCHEMA,
  type AnswerKeyStore, type TemplateSchema, type TemplateVariant,
} from '../../types/grading';

interface SheetChoice { key: string; mode: 'vju' | 'custom'; id: number | null; variant?: TemplateVariant; name: string }

const sel: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 8,
  border: '1.5px solid #D1D5DB', fontSize: 14, fontFamily: 'inherit', background: '#fff',
};

function QrView({ url, fileName, hint }: { url: string | null; fileName: string; hint: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      {url
        ? <img src={url} alt="Mã QR đáp án" style={{ width: 220, height: 220, imageRendering: 'pixelated' }} />
        : <div style={{ width: 220, height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9CA3AF', fontSize: 13 }}>Đang tạo…</div>}
      <div style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', lineHeight: 1.5 }}>{hint}</div>
      {url && (
        <Button size="sm" variant="primary" icon={<Download size={14} />} onClick={() => saveAs(url, fileName)}>
          Tải ảnh QR
        </Button>
      )}
    </div>
  );
}

export default function AnswerQrModal({ open, onClose, examId, examName, fromStore }: {
  open: boolean;
  onClose: () => void;
  /** set = the kỳ thi's QR; unset = make one from an Excel file */
  examId?: number | null;
  examName?: string;
  /** Answer Key → "Tạo mã QR": the đáp án on that page */
  fromStore?: { name: string; templateKey: string; templateLabel: string; store: AnswerKeyStore } | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  // ── kỳ thi ────────────────────────────────────────────────────────────────
  const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => {
    if (!open || examId == null) return;
    setUrl(null); setError(''); setCodes(null);
    examPapersApi.examAnswerKey(examId).then(k => setCodes(k.versions)).catch(() => setCodes([]));
    examPapersApi.answerQr(examId).then(b => setUrl(URL.createObjectURL(b))).catch(() => setError('Không tạo được mã QR'));
  }, [open, examId]);

  // ── đáp án đang có trên trang Answer Key ──────────────────────────────────
  useEffect(() => {
    if (!open || !fromStore) return;
    setUrl(null); setError('');
    const custom = fromStore.templateKey.startsWith('custom:');
    examPapersApi.createAnswerQr({
      name: fromStore.name, template_mode: custom ? 'custom' : 'vju',
      template_id: custom ? Number(fromStore.templateKey.slice('custom:'.length)) : null,
      template_name: fromStore.templateLabel, variant: null, store: fromStore.store,
    })
      .then(({ id }) => examPapersApi.answerQrPng(id))
      .then(b => setUrl(URL.createObjectURL(b)))
      .catch(() => setError('Không tạo được mã QR, kiểm tra mạng rồi thử lại.'));
  }, [open, fromStore]);

  // ── từ file Excel ─────────────────────────────────────────────────────────
  const [customs, setCustoms] = useState<SheetChoice[]>([]);
  const [sheetKey, setSheetKey] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string[]>([]);
  const [made, setMade] = useState<{ codes: string[]; questions: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const sheets: SheetChoice[] = useMemo(() => [
    ...PINNED_TEMPLATES.map(pt => ({ key: `custom:${pt.id}`, mode: 'custom' as const, id: pt.id, name: pt.label })),
    { key: 'vju:sbd8', mode: 'vju', id: null, variant: 'sbd8', name: TEMPLATE_VARIANT_LABEL.sbd8 },
    { key: 'vju:sbd4', mode: 'vju', id: null, variant: 'sbd4', name: TEMPLATE_VARIANT_LABEL.sbd4 },
    ...customs,
  ], [customs]);
  const sheet = sheets.find(s => s.key === sheetKey) ?? sheets[0];

  useEffect(() => {
    if (!open || examId != null || fromStore) return;
    setUrl(null); setError(''); setNote([]); setMade(null);
    customFormsApi.list()
      .then(({ forms }) => setCustoms(forms
        .filter(f => !PINNED_TEMPLATES.some(pt => pt.id === f.id))
        .map(f => ({ key: `custom:${f.id}`, mode: 'custom' as const, id: f.id, name: f.name }))))
      .catch(() => setCustoms([]));
  }, [open, examId]);

  const schemaOf = async (s: SheetChoice): Promise<TemplateSchema | null> => {
    if (s.mode === 'vju' || s.id == null) return VJU_PRESET_SCHEMA;
    try { return buildSchemaFromDetail(await customFormsApi.get(s.id)); } catch { return null; }
  };

  const downloadSample = async () => {
    const schema = await schemaOf(sheet);
    if (!schema) { setError('Không tải được mẫu phiếu'); return; }
    const buf = await buildAnswerKeySampleWorkbook(schema, sheet.name).xlsx.writeBuffer();
    saveAs(new Blob([buf], { type: 'application/octet-stream' }), `Dap an mau - ${sheet.name}.xlsx`);
  };

  /** Same rules as Chấm nhanh → Nhập file đáp án: "Đề 101" sheets, or one
   *  file per mã đề named after it ("Dap an 101.xlsx"). */
  const makeFromFiles = async (files: File[]) => {
    setError(''); setNote([]); setMade(null); setUrl(null);
    setBusy(true);
    try {
      const schema = await schemaOf(sheet);
      if (!schema) { setError('Không tải được mẫu phiếu, thử lại sau.'); return; }
      const now = new Date().toISOString();
      const store: AnswerKeyStore = { answers: {}, scoring: { ...DEFAULT_SCORING }, updatedAt: now };
      const warnings: string[] = [];
      for (const file of files) {
        let parsed;
        try { parsed = await parseAnswerKeyWorkbook(file, schema); }
        catch { warnings.push(`${file.name}: không đọc được file (.xlsx)`); continue; }
        warnings.push(...parsed.warnings.map(w => (files.length > 1 ? `${file.name}: ${w}` : w)));
        store.scoring = parsed.store.scoring;
        const sets = parsed.store.byMaDe && Object.keys(parsed.store.byMaDe).length > 0 ? parsed.store.byMaDe : null;
        const code = sets ? null : maDeFromFileName(file.name);
        if (sets) store.byMaDe = { ...(store.byMaDe ?? {}), ...sets };
        else if (code) store.byMaDe = { ...(store.byMaDe ?? {}), [code]: { answers: parsed.store.answers, scoring: store.scoring, updatedAt: now } };
        else if (files.length === 1) store.answers = parsed.store.answers;
        else warnings.push(`${file.name}: không biết mã đề (đặt tên file kiểu "Dap an 101.xlsx") nên bỏ qua`);
      }
      const byCode = Object.entries(store.byMaDe ?? {}).filter(([, s]) => Object.values(s.answers).some(Boolean));
      const single = Object.values(store.answers).filter(Boolean).length;
      if (byCode.length === 0 && single === 0) {
        setNote(warnings.length ? warnings : ['Không có đáp án nào trong file']);
        return;
      }
      const label = name.trim() || files[0].name.replace(/\.[^.]+$/, '');
      const { id } = await examPapersApi.createAnswerQr({
        name: label, template_mode: sheet.mode, template_id: sheet.id, template_name: sheet.name,
        variant: sheet.variant ?? null, store,
      });
      setUrl(URL.createObjectURL(await examPapersApi.answerQrPng(id)));
      setMade({
        codes: byCode.map(([c]) => c).sort(),
        questions: byCode.length ? Object.keys(byCode[0][1].answers).length : single,
      });
      setNote(warnings);
      if (!name.trim()) setName(label);
    } catch {
      setError('Không tạo được mã QR, kiểm tra mạng rồi thử lại.');
    } finally {
      setBusy(false);
    }
  };

  const scanHint = <>Trong app: <b>Chấm nhanh</b> hoặc <b>Answer Key</b> → <b>Quét mã QR</b> để nạp đáp án. Quét bằng Camera điện thoại / iPad: tải ngay file Excel đáp án.</>;

  return (
    <Modal open={open} onClose={onClose} width={460}
      title={fromStore ? `Mã QR đáp án: ${fromStore.name}` : examId != null ? `Mã QR đáp án${examName ? `: ${examName}` : ''}` : 'Tạo mã QR đáp án từ file Excel'}>
      {error && <div style={{ fontSize: 13, color: '#C8102E', marginBottom: 10 }}>⚠ {error}</div>}

      {fromStore ? (
        <QrView url={url} fileName={`Ma QR dap an - ${fromStore.name}.png`}
          hint={<>{fromStore.templateLabel}<br />{scanHint}</>} />
      ) : examId != null ? (
        codes !== null && codes.length === 0 ? (
          <div style={{ fontSize: 13.5, color: '#6B7280', lineHeight: 1.6 }}>
            Kỳ thi chưa gắn bộ đề trộn nào nên mã QR chưa có đáp án. Trộn đề và gắn vào kỳ thi trước,
            hoặc dùng <b>Tạo QR đáp án từ file Excel</b> ở trang Trộn đề.
          </div>
        ) : (
          <QrView url={url} fileName={`Ma QR dap an - ${examName ?? examId}.png`}
            hint={<>{codes && codes.length > 0 && <><b>{codes.length} mã đề</b> ({codes.join(', ')}) · </>}{scanHint}</>} />
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5, color: '#6B7280', fontWeight: 600 }}>
            1. Mẫu phiếu
            <select value={sheet?.key ?? ''} onChange={e => { setSheetKey(e.target.value); setUrl(null); setMade(null); }} style={sel}>
              {sheets.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5, color: '#6B7280', fontWeight: 600 }}>
            2. Tên (để nhận ra khi quét)
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Ví dụ: Giữa kỳ Toán 1 – 4 mã đề" style={sel} />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" variant="secondary" icon={<Download size={14} />} onClick={() => { void downloadSample(); }}>
              Tải Excel mẫu
            </Button>
            <Button size="sm" variant="primary" icon={<FileUp size={14} />} loading={busy} onClick={() => fileRef.current?.click()}>
              3. Chọn file đáp án → Tạo QR
            </Button>
            <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) void makeFromFiles(f); }} />
          </div>
          <div style={{ fontSize: 12, color: '#9CA3AF', lineHeight: 1.5 }}>
            Nhiều mã đề: một file có các sheet “Đề 101”, “Đề 102”… (như Answer Key → Xuất Excel), hoặc chọn nhiều file đặt tên theo mã đề (“Dap an 101.xlsx”).
          </div>
          {made && (
            <div style={{ borderTop: '1px dashed #E5E7EB', paddingTop: 12 }}>
              <QrView url={url} fileName={`Ma QR dap an - ${name || 'dap an'}.png`}
                hint={<><b>{made.codes.length ? `${made.codes.length} mã đề (${made.codes.join(', ')})` : '1 bộ đáp án'}</b> · {made.questions} câu · {sheet.name}<br />{scanHint}</>} />
            </div>
          )}
          {note.length > 0 && (
            <div style={{ fontSize: 12.5, color: '#B45309', lineHeight: 1.5 }}>
              {note.slice(0, 4).map((w, i) => <div key={i}>⚠ {w}</div>)}
              {note.length > 4 && <div>… và {note.length - 4} cảnh báo khác</div>}
            </div>
          )}
        </div>
      )}
      {examId == null && !fromStore && !made && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, fontSize: 12, color: '#9CA3AF' }}>
          <QrCode size={14} /> Mã QR chỉ trỏ tới đáp án lưu trên máy chủ, nên nhỏ và dễ quét.
        </div>
      )}
    </Modal>
  );
}
