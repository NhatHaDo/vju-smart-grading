import { useState } from 'react';
import { X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { OmrGradeResult, AnswerKeyStore, ManualCorrection, InfoFieldColumn, TemplateSchema, TemplateAnswerSection } from '../../types/grading';
import { VJU_PRESET_SCHEMA, computeScore } from '../../types/grading';
import { buildSchemaFromAnswerKeys } from '../../utils/templateSchema';
import { getInfoFieldValue } from '../../utils/resultMapping';
import SheetImageViewer from './SheetImageViewer';

type Filter = 'all' | 'correct' | 'wrong' | 'blank' | 'warn';

interface Props {
  r: OmrGradeResult;
  correction: ManualCorrection | undefined;
  answerKey: AnswerKeyStore | null;
  onClose: () => void;
  /** Dynamic schema — drives info header + answer grid. Falls back to VJU preset. */
  templateSchema?: TemplateSchema | null;
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
export default function ResultDetailModal({ r, correction, answerKey, onClose, templateSchema }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
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

  const corrected  = !!correction;
  const warnList   = r.warnings ?? [];
  const hasWarning = warnList.length > 0;
  const debug      = r.debug ?? {};
  const sc         = answerKey ? computeScore(answers, answerKey) : null;

  function qStatus(lbl: string): 'correct' | 'wrong' | 'blank' | 'warn' | 'no-key' {
    const warnQ = warnList.find(w => w.field === lbl);
    if (warnQ) return 'warn';
    const ans = answers[lbl];
    if (!answerKey) return 'no-key';
    const key = answerKey.answers[lbl];
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
                {schema.infoFields.map(field => (
                  <div key={field.key} style={{ fontSize: 12 }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>{field.displayName}: </span>
                    <InfoFieldValue
                      label={field.displayName}
                      raw={getInfoFieldValue(student_info, r.info_field_columns, field) || student_info?.[field.key] || null}
                      columns={r.info_field_columns?.[field.key]}
                    />
                  </div>
                ))}
              </div>
            </div>
            <button
              onClick={onClose}
              style={{ border: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 8, cursor: 'pointer', color: '#fff', padding: 7, display: 'flex', flexShrink: 0 }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

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
                <div style={{ gridColumn: '1/-1', fontSize: 12, color: '#9CA3AF', textAlign: 'center', padding: '10px 0' }}>
                  Chưa có Answer Key
                </div>
              )}
            </div>

            {sc && (
              <div style={{ background: '#F9FAFB', borderRadius: 10, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>Điểm</span>
                <span style={{ fontSize: 24, fontWeight: 800, color: '#C8102E' }}>{sc.total}</span>
              </div>
            )}

            {/* Filter + answer grid */}
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
                    Template này không có câu hỏi MCQ.
                  </div>
                )}
                {schemaDerived && (
                  <div style={{ fontSize: 10, color: '#92400E', background: '#FEF9C3', borderRadius: 6, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertTriangle size={10} />
                    Hiển thị từ dữ liệu thực — schema đang tải hoặc chưa lưu
                  </div>
                )}
                {effectiveAnswerSections.map(({ name: section, labels }) => {
                  const visible = labels.filter(lbl => filter === 'all' || qStatus(lbl) === filter);
                  if (visible.length === 0) return null;
                  return (
                    <div key={section}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#6B7280', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{section}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {visible.map(lbl => {
                          const st  = qStatus(lbl);
                          const ans = answers[lbl];
                          const gi  = allAnswerLabels.indexOf(lbl) + 1;
                          return (
                            <div key={lbl} style={{
                              width: 42, height: 42, borderRadius: 8,
                              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
                              background: STATUS_COLOR[st], border: `1.5px solid ${STATUS_BORDER[st]}`,
                            }}>
                              <span style={{ fontSize: 9, color: STATUS_TEXT[st], fontWeight: 500 }}>C{gi}</span>
                              <span style={{ fontSize: 13, fontWeight: 800, color: STATUS_TEXT[st] }}>{ans || '—'}</span>
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
                      <span><strong>{w.field}</strong>: {w.type}{w.candidates?.length ? ` (${w.candidates.join(',')})` : ''}</span>
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
