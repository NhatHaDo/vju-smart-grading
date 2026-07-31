import { useState, useEffect } from 'react';
import { X, AlertTriangle, CheckCircle2, Pencil, Save, RotateCcw } from 'lucide-react';
import type { OmrGradeResult, AnswerKeyStore, ManualCorrection, InfoFieldColumn, TemplateSchema, TemplateAnswerSection, TemplateInfoField, OmrWarning } from '../../types/grading';
import { VJU_PRESET_SCHEMA, computeScore, resolveAnswerKeyForMaDe, getMaDeValue } from '../../types/grading';
import { buildSchemaFromAnswerKeys } from '../../utils/templateSchema';
import { getInfoFieldValue } from '../../utils/resultMapping';
import SheetImageViewer from './SheetImageViewer';

type Filter = 'all' | 'correct' | 'wrong' | 'blank' | 'warn';
const CHOICES = ['—', 'A', 'B', 'C', 'D'];

interface Props {
  r: OmrGradeResult;
  correction: ManualCorrection | undefined;
  answerKey: AnswerKeyStore | null;
  onClose: () => void;
  /** Dynamic schema — drives info header + answer grid. Falls back to VJU preset. */
  templateSchema?: TemplateSchema | null;
  /** 2026-07-30/31: "check lỗi cần cho GV sửa trực tiếp ở màn view" — when
   *  both are provided, every answer cell becomes directly clickable to edit
   *  right here (no separate "edit mode" toggle — 2026-07-31: "t cần sửa đáp
   *  án ngay trong đây... ấn sửa luôn chứ ko phải ấn vào chỉnh sửa nữa").
   *  Omit both to keep this modal read-only (e.g. if reused somewhere that
   *  shouldn't allow edits). */
  onSaveCorrection?: (filename: string, c: ManualCorrection) => void;
  onResetCorrection?: (filename: string) => void;
}

const STATUS_COLOR:  Record<string, string> = { correct:'#D1FAE5', wrong:'#FEE2E2', blank:'#fff',     warn:'#EDE9FE', 'no-key':'#F3F4F6' };
const STATUS_TEXT:   Record<string, string> = { correct:'#065F46', wrong:'#991B1B', blank:'#9CA3AF', warn:'#5B21B6', 'no-key':'#6B7280' };
const STATUS_BORDER: Record<string, string> = { correct:'#6EE7B7', wrong:'#FCA5A5', blank:'#E5E7EB', warn:'#C4B5FD', 'no-key':'#E5E7EB' };

// ── InfoFieldValue ────────────────────────────────────────────────────────────
interface InfoFieldValueProps {
  label:    string;
  raw:      string | null | undefined;
  columns?: InfoFieldColumn[];
}

function InfoFieldValue({ label, raw, columns }: InfoFieldValueProps) {
  if (!columns || columns.length === 0) {
    const hasBlank = String(raw ?? '').includes('_');
    return (
      <span style={{ fontWeight: 700, fontFamily: 'monospace', color: hasBlank ? '#FCD34D' : '#fff' }}>
        {raw ?? '—'}
      </span>
    );
  }

  return (
    <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>
      {columns.map((col, i) => {
        if (col.status === 'blank') {
          return <span key={i} style={{ color: 'rgba(255,255,255,0.35)' }}>_</span>;
        }
        if (col.status === 'multi_mark') {
          return (
            <span
              key={i}
              title={`${label} cột ${col.columnIndex + 1} có nhiều ô tô: ${col.digits.join(',')}`}
              style={{ background: '#FEF08A', color: '#713F12', borderRadius: 3, padding: '0 3px', cursor: 'help' }}
            >
              {col.value}
            </span>
          );
        }
        if (col.status === 'too_light') {
          return (
            <span key={i} title={`${label} cột ${col.columnIndex + 1}: ô tô mờ`} style={{ color: '#FCD34D', cursor: 'help' }}>
              {col.value}
            </span>
          );
        }
        return <span key={i} style={{ color: '#fff' }}>{col.value}</span>;
      })}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ResultDetailModal({ r, correction, answerKey, onClose, templateSchema, onSaveCorrection, onResetCorrection }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [editInfo, setEditInfo] = useState<Record<string, string>>({});
  const [editAnswers, setEditAnswers] = useState<Record<string, string>>({});
  const canEdit = !!onSaveCorrection;
  const schema = templateSchema ?? VJU_PRESET_SCHEMA;

  // Safety net: if schema has no answer sections but the row has actual answers,
  // derive sections from the answer keys. This handles the case where schema
  // hasn't been fetched yet or was lost during DB round-trip.
  const effectiveAnswerSections: TemplateAnswerSection[] = (() => {
    if (schema.answerSections.length > 0) return schema.answerSections;
    const rawAnswers = r.answers ?? {};
    const nonNullKeys = Object.keys(rawAnswers).filter(k => rawAnswers[k] !== null && rawAnswers[k] !== undefined);
    if (nonNullKeys.length === 0) return [];
    return buildSchemaFromAnswerKeys(nonNullKeys).answerSections;
  })();
  const schemaDerived = schema.answerSections.length === 0 && effectiveAnswerSections.length > 0;

  const allAnswerLabels = effectiveAnswerSections.flatMap(s => s.labels);

  // Merge correction
  const student_info = correction
    ? { ...r.student_info, ...correction.corrected_student_info }
    : (r.student_info ?? {});
  const answers = correction
    ? { ...r.answers, ...correction.corrected_answers }
    : (r.answers ?? {});

  // Starting value for one info field when entering edit mode — factored out
  // so handleSaveEdit's diff below computes against the exact same baseline,
  // instead of drifting out of sync with a second, hand-copied formula.
  function startingInfoValue(field: TemplateInfoField): string {
    return String(
      correction?.corrected_student_info?.[field.key]
      ?? (student_info[field.key] != null ? student_info[field.key] : undefined)
      ?? getInfoFieldValue(student_info, r.info_field_columns, field)
      ?? ''
    );
  }

  // 2026-07-31: "t cần sửa đáp án ngay trong đây, ko phải ấn vào chỉnh sửa
  // nữa" — this modal used to gate all editing behind a separate "editMode"
  // toggle (click "Sửa đáp án" first, THEN cells become clickable). Now every
  // cell is always directly clickable — there's no more separate mode, so
  // editAnswers/editInfo are seeded once on mount instead of only when a
  // button was pressed. Saving still requires an explicit "Lưu sửa" click
  // (confirmed with the user) — only the "enter edit mode" step is gone.
  function seedEditsFromCurrent() {
    const info: Record<string, string> = {};
    for (const field of schema.infoFields) info[field.key] = startingInfoValue(field);
    const ans: Record<string, string> = {};
    for (const lbl of allAnswerLabels) ans[lbl] = String(answers[lbl] ?? '');
    setEditInfo(info);
    setEditAnswers(ans);
  }
  useEffect(() => {
    seedEditsFromCurrent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setEditAns = (lbl: string, val: string) =>
    setEditAnswers(prev => ({ ...prev, [lbl]: val === '—' ? '' : val }));
  function handleSaveEdit() {
    if (!onSaveCorrection) return;
    // 2026-07-31: "ko phải vậy, mà là cái nào tôi đã sửa/ ấn sửa thôi chứ" —
    // this used to send the ENTIRE editAnswers/editInfo snapshot (every
    // question/field, touched or not — enterEditMode pre-fills all of them
    // so the form has values to show) as "corrected_answers", so literally
    // every question ended up flagged as "manually corrected" the instant
    // ANY single one was changed and saved. Only keep entries whose value
    // actually differs from what it was when this edit session started, and
    // merge with whatever was already recorded as corrected in prior
    // sessions (a save must not un-flag/lose those).
    const changedAnswers: Record<string, string> = {};
    for (const lbl of allAnswerLabels) {
      const editVal = editAnswers[lbl] ?? '';
      const origVal = String(answers[lbl] ?? '');
      if (editVal !== origVal) changedAnswers[lbl] = editVal;
    }
    const changedInfo: Record<string, string> = {};
    for (const field of schema.infoFields) {
      const editVal = editInfo[field.key] ?? '';
      const origVal = startingInfoValue(field);
      if (editVal !== origVal) changedInfo[field.key] = editVal;
    }
    onSaveCorrection(r.input?.filename ?? '', {
      corrected_student_info: { ...(correction?.corrected_student_info ?? {}), ...changedInfo },
      corrected_answers:      { ...(correction?.corrected_answers ?? {}),      ...changedAnswers },
      updatedAt:               new Date().toISOString(),
    });
  }
  function handleResetEdit() {
    if (onResetCorrection) onResetCorrection(r.input?.filename ?? '');
    // Correction is now cleared — reseed the editable fields from the raw,
    // never-corrected OMR read (not from `answers`/`student_info`, which
    // still reflect the about-to-be-cleared correction until the parent
    // re-renders with the updated prop).
    const info: Record<string, string> = {};
    for (const field of schema.infoFields) {
      info[field.key] = String(
        getInfoFieldValue(r.student_info ?? {}, r.info_field_columns, field)
        ?? (r.student_info?.[field.key] ?? '')
        ?? ''
      );
    }
    const ans: Record<string, string> = {};
    for (const lbl of allAnswerLabels) ans[lbl] = String(r.answers?.[lbl] ?? '');
    setEditInfo(info);
    setEditAnswers(ans);
  }

  const corrected  = !!correction;
  const warnList   = r.warnings ?? [];
  const hasWarning = warnList.length > 0;
  const debug      = r.debug ?? {};
  const maDeValue = getMaDeValue(student_info, schema);
  const { key: rowAnswerKey, missingKeyForMaDe } = resolveAnswerKeyForMaDe(answerKey, maDeValue);
  const sc         = rowAnswerKey ? computeScore(answers, rowAnswerKey) : null;
  // A key can exist for this mã đề but only have some questions filled in —
  // those un-filled questions show as grey/"no-key" per-question below, which
  // looks like a glitch unless we spell out why (see AnswerKeyPage "Đề X" tab).
  const keyFilledCount = rowAnswerKey ? allAnswerLabels.filter(l => rowAnswerKey.answers[l]).length : 0;
  const isPartialKey   = !!rowAnswerKey && allAnswerLabels.length > 0 && keyFilledCount < allAnswerLabels.length;

  // Turns a raw backend warning ({field:"tn27", type:"multi_mark", candidates:["C","D"]})
  // into a plain-Vietnamese sentence a lecturer can act on without knowing the
  // internal field naming or English status codes. Previously this rendered
  // literally as "tn27: multi_mark (C,D)" — meaningless without reading code.
  function describeWarning(w: OmrWarning): string {
    const cands = w.candidates?.length ? w.candidates.join(' và ') : '';
    const isInfo = w.type.endsWith('_info_field');

    if (isInfo) {
      const infoField  = schema.infoFields.find(f => f.key === w.field);
      const fieldName  = infoField?.displayName || w.field;
      const colMatch   = w.column?.match(/(\d+)$/);
      const colLabel   = colMatch ? ` (cột ${colMatch[1]})` : '';
      return w.type === 'multi_mark_info_field'
        ? `${fieldName}${colLabel}: tô nhiều số (${cands}) — cần xem lại phiếu gốc`
        : `${fieldName}${colLabel}: số "${cands}" tô hơi mờ — nên xác nhận lại`;
    }

    // MCQ-type: mirror the backend's own "Câu N" convention (trailing digits
    // of the field key) so this always matches the number shown in the grid
    // above, regardless of how sections are grouped.
    const m = w.field.match(/(\d+)$/);
    const qLabel = m ? `Câu ${parseInt(m[1], 10)}` : w.field;
    if (w.type === 'multi_mark')   return `${qLabel}: tô nhiều đáp án (${cands}) — cần xem lại phiếu gốc`;
    if (w.type === 'too_light')    return `${qLabel}: đáp án "${cands}" tô hơi mờ — nên xác nhận lại`;
    // needs_review
    return cands
      ? `${qLabel}: chưa đủ rõ để phân biệt (${cands}) — cần xem lại phiếu gốc`
      : `${qLabel}: chưa đủ rõ để xác định đáp án — cần xem lại phiếu gốc`;
  }

  // 2026-07-31: "mấy cái đáp án nó ko có cảnh báo, lúc t sửa xong thì trong
  // lúc sửa với lúc xem lại kq nó ko có gì để nhận biết à?" — a question with
  // no OMR warning that a teacher manually corrected had zero visual trace
  // afterward: not in edit mode (isChanged only compares against THIS
  // session's starting value, which already includes prior corrections —
  // so reopening edit mode showed no highlight at all for old corrections),
  // and not in the read-only view either (only correct/wrong/blank/warn
  // colors, no "was this hand-edited" signal). Amber ring = "manually
  // corrected at some point", independent of session/status, everywhere.
  function wasCorrected(lbl: string): boolean {
    if (!correction?.corrected_answers || !Object.prototype.hasOwnProperty.call(correction.corrected_answers, lbl)) return false;
    // 2026-07-31: "cái nào sửa mới vàng nhạt thôi, còn đâu vẫn thế (trắng)
    // chứ?" — checking presence alone isn't enough: corrections saved
    // BEFORE the earlier fix (2026-07-31, same day) still have EVERY
    // question crammed into corrected_answers, touched or not, so presence
    // matched on all 79. Comparing against `r.answers` — the raw, never-
    // mutated OMR read — instead of just checking the key exists makes this
    // self-healing for that old data too: a stale entry whose value happens
    // to equal what OMR originally read isn't visually "corrected" anyway.
    const correctedVal = String(correction.corrected_answers[lbl] ?? '');
    const originalVal  = String(r.answers?.[lbl] ?? '');
    return correctedVal !== originalVal;
  }

  function qStatus(lbl: string): 'correct' | 'wrong' | 'blank' | 'warn' | 'no-key' {
    const warnQ = warnList.find(w => w.field === lbl);
    if (warnQ) return 'warn';
    const ans = answers[lbl];
    if (!rowAnswerKey) return 'no-key';
    const key = rowAnswerKey.answers[lbl];
    if (!key) return 'no-key';
    if (!ans) return 'blank';
    return ans === key ? 'correct' : 'wrong';
  }

  const filterButtons: { key: Filter; label: string; color: string }[] = [
    { key: 'all',     label: 'Tất cả',   color: '#374151' },
    { key: 'correct', label: 'Đúng',     color: '#065F46' },
    { key: 'wrong',   label: 'Sai',      color: '#991B1B' },
    { key: 'blank',   label: 'Bỏ trống', color: '#92400E' },
    { key: 'warn',    label: 'Cần xem',  color: '#C2410C' },
  ];

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000, padding: '16px',
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: '#fff', borderRadius: 16,
        width: '95vw', height: '92vh',
        maxWidth: 1600,
        boxShadow: '0 32px 100px rgba(0,0,0,0.3)',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>

        {/* ── Red header ── */}
        <div style={{ background: '#C8102E', padding: '14px 20px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={{ fontWeight: 700, color: '#fff', fontSize: 15 }}>{r.input?.filename ?? '—'}</span>
                {hasWarning && (
                  <span style={{ background: '#FCD34D', color: '#78350F', fontSize: 10, fontWeight: 700, borderRadius: 9999, padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <AlertTriangle size={10} /> {warnList.length} cảnh báo
                  </span>
                )}
                {corrected && (
                  <span style={{ background: '#D1FAE5', color: '#065F46', fontSize: 10, fontWeight: 700, borderRadius: 9999, padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <CheckCircle2 size={10} /> Đã sửa tay
                  </span>
                )}
                {r._error && (
                  <span style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 10, fontWeight: 700, borderRadius: 9999, padding: '2px 8px' }}>Lỗi API</span>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px' }}>
                {schema.infoFields.map(field => {
                  // Once a field has been manually corrected, the per-column digit
                  // breakdown below (yellow-highlighted ambiguous digits etc.) still
                  // reflects the ORIGINAL OMR read — corrections only patch the flat
                  // string, not that column-by-column data. Showing the raw breakdown
                  // here would silently ignore the correction and display stale data,
                  // so once corrected we just show the plain corrected string instead.
                  const isFieldCorrected = correction?.corrected_student_info?.[field.key] !== undefined;
                  return (
                    <div key={field.key} style={{ fontSize: 12 }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{field.displayName}: </span>
                      <InfoFieldValue
                        label={field.displayName}
                        raw={getInfoFieldValue(student_info, r.info_field_columns, field) || student_info?.[field.key] || null}
                        columns={isFieldCorrected ? undefined : r.info_field_columns?.[field.key]}
                      />
                    </div>
                  );
                })}
              </div>
              {/* "ở góc trên bên trái: có 2 chữ kí, cần xác định được điều
                 này ở mỗi bài với OMR" — mean-pixel ink check in the 4
                 CÁN BỘ COI THI/CHẤM THI boxes. null/undefined = not
                 checked (custom template), not "all missing".
                 2026-07-31: "thế thì cần tick làm gì? nếu ko tick thì ko
                 phát hiện chứ nhỉ" — a missing box only gets the alarming
                 "✗ chưa ký" treatment if "Có cán bộ coi thi/chấm thi" is
                 ticked for this row's mã đề on Answer Key; an unticked role
                 isn't expected here at all, so its empty box isn't shown as
                 a problem. Present (✓) boxes still show regardless — that's
                 just good news, never confusing. */}
              {(() => {
                const isRoleRequired = (key: string) =>
                  !!rowAnswerKey?.proctors?.[key.startsWith('coi_thi') ? 'coi_thi' : 'cham_thi'];
                const visibleSigs = (r.signatures ?? []).filter(s => s.present || isRoleRequired(s.key));
                if (visibleSigs.length === 0) return null;
                return (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {visibleSigs.map(s => (
                      <span
                        key={s.key}
                        title={s.present ? undefined : `Ô "${s.label}" có vẻ chưa được ký (mean=${s.mean_gray})`}
                        style={{
                          fontSize: 10.5, fontWeight: 700, borderRadius: 9999, padding: '2px 8px',
                          background: s.present ? 'rgba(255,255,255,0.15)' : '#FCD34D',
                          color: s.present ? 'rgba(255,255,255,0.85)' : '#78350F',
                        }}
                      >
                        {s.present ? '✓' : '✗'} {s.label}
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>
            <button
              onClick={onClose}
              style={{ border: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 8, cursor: 'pointer', color: '#fff', padding: 7, display: 'flex', flexShrink: 0 }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* ── Sticky action bar — 2026-07-31: always visible when this row is
           editable (no more separate "edit mode" to enter first). Every cell
           below is directly clickable; this bar is just where you commit
           ("Lưu sửa") or discard ("Hủy") whatever you've changed. ── */}
        {canEdit && (
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 20px', background: '#FFF9F9', borderBottom: '1px solid #FECACA' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#C8102E', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Pencil size={13} /> Bấm trực tiếp vào ô câu nào cần sửa bên trái — nhớ bấm "Lưu sửa" sau khi xong
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={handleSaveEdit} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#C8102E', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              <Save size={13} /> Lưu sửa
            </button>
            {onResetCorrection && (
              <button onClick={handleResetEdit} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', color: '#6B7280', border: '1.5px solid #E5E7EB', borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                <RotateCcw size={13} /> Reset về gốc
              </button>
            )}
            <button onClick={seedEditsFromCurrent} title="Bỏ các thay đổi chưa lưu, quay về đáp án hiện tại" style={{ background: '#fff', color: '#6B7280', border: '1.5px solid #E5E7EB', borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              Hủy sửa
            </button>
          </div>
        )}

        {/* ── Body: 38 / 62 split ── */}
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '38% 62%', minHeight: 0 }}>

          {/* ── Left panel: score + answers + debug ── */}
          <div style={{ borderRight: '1px solid #F3F4F6', overflowY: 'auto', padding: '18px', display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Score cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {sc ? [
                { label: 'Đúng',  val: sc.correct, color: '#065F46', bg: '#D1FAE5' },
                { label: 'Sai',   val: sc.wrong,   color: '#991B1B', bg: '#FEE2E2' },
                { label: 'Trống', val: sc.blank,   color: '#92400E', bg: '#FEF9C3' },
              ].map(s => (
                <div key={s.label} style={{ background: s.bg, borderRadius: 10, padding: '10px 8px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: s.color, fontWeight: 700, marginBottom: 2 }}>{s.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.val}</div>
                </div>
              )) : (
                <div style={{ gridColumn: '1/-1', fontSize: 12, color: missingKeyForMaDe ? '#CA8A04' : '#9CA3AF', textAlign: 'center', padding: '10px 0' }}>
                  {missingKeyForMaDe
                    ? `Chưa nhập đáp án cho Mã đề ${maDeValue ?? '?'} ở trang Answer Key`
                    : 'Chưa có Answer Key'}
                </div>
              )}
            </div>

            {isPartialKey && (
              <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '8px 12px', fontSize: 11.5, color: '#92400E', lineHeight: 1.5 }}>
                Đề <strong>{maDeValue ?? '?'}</strong> mới nhập <strong>{keyFilledCount}/{allAnswerLabels.length}</strong> câu ở Answer Key —
                các câu chưa nhập hiện màu <strong>xám</strong> bên dưới (chưa chấm được).
                Vào Answer Key → tab Đề {maDeValue} để nhập nốt.
              </div>
            )}

            {sc && (
              <div style={{ background: '#F9FAFB', borderRadius: 10, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>Điểm</span>
                <span style={{ fontSize: 24, fontWeight: 800, color: '#C8102E' }}>{sc.total}</span>
              </div>
            )}

            {/* Editable student-info block — shown whenever this row is editable */}
            {canEdit && schema.infoFields.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Thông tin sinh viên</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  {schema.infoFields.map(field => (
                    <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={{ fontSize: 10, fontWeight: 600, color: '#6B7280' }}>{field.displayName}</label>
                      <input
                        value={editInfo[field.key] ?? ''}
                        onChange={e => setEditInfo(prev => ({ ...prev, [field.key]: e.target.value }))}
                        style={{ padding: '6px 9px', borderRadius: 7, border: '1.5px solid #E5E7EB', fontSize: 12, fontFamily: 'monospace', outline: 'none' }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Filter + answer grid — every cell is directly clickable to
               edit when canEdit (2026-07-31: no more separate "edit mode"
               gate); falls back to plain read-only colored boxes when this
               modal is reused somewhere without onSaveCorrection. */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Chi tiết câu hỏi</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
                {filterButtons.map(f => (
                  <button key={f.key} onClick={() => setFilter(f.key)} style={{
                    padding: '3px 10px', borderRadius: 9999, border: '1.5px solid',
                    borderColor: filter === f.key ? f.color : '#E5E7EB',
                    background: filter === f.key ? '#F9FAFB' : '#fff',
                    color: filter === f.key ? f.color : '#9CA3AF',
                    fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  }}>{f.label}</button>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {effectiveAnswerSections.length === 0 && (
                  <div style={{ fontSize: 12, color: '#9CA3AF', textAlign: 'center', padding: '12px 0' }}>
                    Template này không có câu trắc nghiệm.
                  </div>
                )}
                {schemaDerived && (
                  <div style={{ fontSize: 10, color: '#92400E', background: '#FEF9C3', borderRadius: 6, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertTriangle size={10} />
                    Hiển thị từ dữ liệu thực — schema đang tải hoặc chưa lưu
                  </div>
                )}
                {effectiveAnswerSections.map(({ name: section, labels, inputType, options }) => {
                  const visible = labels.filter(lbl => filter === 'all' || qStatus(lbl) === filter);
                  if (visible.length === 0) return null;
                  const isText = inputType === 'text';
                  const choices = ['—', ...(options && options.length > 0 ? options : CHOICES.slice(1))];
                  return (
                    <div key={section}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#6B7280', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{section}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {visible.map(lbl => {
                          const st  = qStatus(lbl);
                          const gi  = allAnswerLabels.indexOf(lbl) + 1;

                          if (!canEdit) {
                            // Plain read-only box (modal reused without edit capability).
                            const ans = answers[lbl];
                            const wasCorr = wasCorrected(lbl);
                            const bg     = wasCorr ? '#FEF9C3' : STATUS_COLOR[st];
                            const border = wasCorr ? '#FDE68A' : STATUS_BORDER[st];
                            const textCl = wasCorr ? '#92400E' : STATUS_TEXT[st];
                            return (
                              <div key={lbl} title={wasCorr ? 'Đã sửa tay' : undefined} style={{
                                minWidth: isText ? 74 : 42, height: 42, borderRadius: 8, padding: isText ? '0 6px' : 0,
                                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
                                background: bg, border: `1.5px solid ${border}`,
                              }}>
                                <span style={{ fontSize: 9, color: textCl, fontWeight: 500 }}>C{gi}</span>
                                <span style={{ fontSize: isText ? 12 : 13, fontWeight: 800, color: textCl, fontFamily: isText ? 'monospace' : 'inherit', whiteSpace: 'nowrap' }}>{ans || '—'}</span>
                              </div>
                            );
                          }

                          // 2026-07-31: "bấm vào ô đỏ là sửa luôn, ko cần ấn
                          // sửa nữa" — every cell (đúng/sai/trống/cảnh báo) is
                          // a live dropdown/input at all times. Base color =
                          // correct/wrong/blank/warn status (same palette as
                          // the read-only view above), overridden by pastel
                          // yellow the moment the value differs from the
                          // saved answer — whether that's a fresh change made
                          // just now in this session, or a correction already
                          // saved from a previous session (wasCorrected).
                          const val = editAnswers[lbl] ?? '';
                          const original = String(answers[lbl] ?? '');
                          const isChanged  = val !== original;
                          const highlight  = isChanged || wasCorrected(lbl);
                          const warnQ = warnList.find(w => w.field === lbl);
                          const tip = isChanged
                            ? `Đã sửa (gốc: ${original || '—'})`
                            : highlight ? 'Đã sửa tay'
                            : warnQ ? describeWarning(warnQ) : undefined;
                          const borderColor = highlight ? '#FDE68A' : STATUS_BORDER[st];
                          const textColor   = highlight ? '#92400E' : STATUS_TEXT[st];
                          const bgColor     = highlight ? '#FEF9C3' : STATUS_COLOR[st];
                          const commonStyle = {
                            border: `1.5px solid ${borderColor}`,
                            fontSize: 12, fontWeight: 700, color: textColor,
                            background: bgColor,
                            cursor: isText ? 'text' as const : 'pointer' as const, outline: 'none', textAlign: 'center' as const,
                          };
                          if (isText) {
                            return (
                              <div key={lbl} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                                <span style={{ fontSize: 9, color: '#9CA3AF' }}>C{gi}</span>
                                <input
                                  type="text" value={val} onChange={e => setEditAns(lbl, e.target.value)}
                                  placeholder="-12.34" title={tip}
                                  style={{ ...commonStyle, padding: '4px 6px', borderRadius: 6, width: 74, fontFamily: 'monospace' }}
                                />
                              </div>
                            );
                          }
                          return (
                            <div key={lbl} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                              <span style={{ fontSize: 9, color: '#9CA3AF' }}>C{gi}</span>
                              <select
                                value={val || '—'} onChange={e => setEditAns(lbl, e.target.value)}
                                title={tip}
                                style={{ ...commonStyle, padding: '4px 2px', borderRadius: 6, width: 42, fontFamily: 'inherit' }}
                              >
                                {choices.map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Warnings */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Cảnh báo</div>
              {warnList.length === 0
                ? <div style={{ fontSize: 12, color: '#10B981', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <CheckCircle2 size={12} /> Không có cảnh báo
                  </div>
                : warnList.map((w, i) => (
                    <div key={i} style={{ fontSize: 12, color: '#B45309', background: '#FFFBEB', borderRadius: 7, padding: '6px 10px', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <AlertTriangle size={11} style={{ flexShrink: 0 }} />
                      <span>{describeWarning(w)}</span>
                    </div>
                  ))
              }
            </div>

            {/* Debug info */}
            <div style={{ fontSize: 10, color: '#9CA3AF', background: '#F9FAFB', borderRadius: 8, padding: '8px 10px' }}>
              <div><strong>Threshold:</strong> {debug.threshold ?? '—'}</div>
              <div><strong>Mode:</strong> {debug.mean_mode ?? '—'} · {debug.prep_method ?? '—'}</div>
              {debug.image_source && (
                <div style={{ marginTop: 3 }}>
                  <strong>Nguồn ảnh:</strong>{' '}
                  <span style={{ fontWeight: 700, color: debug.image_source === 'camera' ? '#B45309' : '#374151' }}>
                    {debug.image_source}
                  </span>
                </div>
              )}
              {debug.preprocess_strategy_used && (
                <div style={{ marginTop: 2 }}><strong>Strategy:</strong> {debug.preprocess_strategy_used}</div>
              )}
              {debug.alignment_info && (
                <div style={{
                  marginTop: 4, fontSize: 10, fontWeight: 600,
                  color: debug.prep_method === 'markers' ? '#065F46'
                    : debug.prep_method === 'croppage' ? '#92400E'
                    : debug.prep_method === 'fallback_no_warp' ? '#B45309'
                    : '#991B1B',
                }}>
                  {debug.alignment_info}
                </div>
              )}
              {debug.marker_quality_score != null && (
                <div style={{ marginTop: 3, color: debug.warp_used ? '#065F46' : '#B45309' }}>
                  <strong>Marker quality:</strong> {(debug.marker_quality_score * 100).toFixed(0)}%
                  {' · '}
                  <strong>Warp:</strong> {debug.warp_used ? '✓ applied' : '✗ rejected'}
                </div>
              )}
              {debug.warp_rejected_reason && (
                <div style={{ color: '#D97706', marginTop: 2, fontSize: 9 }}>
                  Lý do: {debug.warp_rejected_reason}
                </div>
              )}
              {debug.marker_centers_detected && debug.marker_centers_detected.length > 0 && (
                <div style={{ marginTop: 4, color: '#6B7280' }}>
                  {debug.marker_centers_detected.map(m => (
                    <span key={m.quad} style={{ marginRight: 6 }}>
                      {m.quad}:({Math.round(m.cx)},{Math.round(m.cy)})
                    </span>
                  ))}
                </div>
              )}
              {(debug.alignment_warnings ?? []).length > 0 && (
                <div style={{ color: '#F59E0B', marginTop: 2 }}>{debug.alignment_warnings.join('; ')}</div>
              )}
            </div>
          </div>

          {/* ── Right panel: SheetImageViewer ── */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, padding: '12px' }}>
            <SheetImageViewer
              debug={debug}
              originalFallback={r.input?.saved_as}
              defaultTab="detect"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
