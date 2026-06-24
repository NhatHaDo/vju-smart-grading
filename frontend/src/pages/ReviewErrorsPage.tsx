import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import PageHeader from '../components/layout/PageHeader';
import { AlertTriangle, CheckCircle2, Edit3, RotateCcw, X, Save } from 'lucide-react';
import SheetImageViewer from '../components/results/SheetImageViewer';
import {
  SECTION_MAP,
  TEMPLATE_VARIANT_LABEL,
  type BatchGradeState,
  type OmrGradeResult,
  type AnswerKeyStore,
  type ManualCorrection,
  type CorrectionsStore,
  type InfoFieldColumns,
  loadAnswerKey,
  loadCorrections,
  saveCorrections,
  computeScore,
} from '../types/grading';
import { resultsApi, type BatchResultOut } from '../services/apiClient';

const BATCH_LS_KEY  = 'vju_last_batch_grade';
const CHOICES = ['—', 'A', 'B', 'C', 'D'];
const ALL_LABELS = Object.values(SECTION_MAP).flat();

function loadBatch(): BatchGradeState | null {
  try {
    const raw = localStorage.getItem(BATCH_LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as BatchGradeState;
    if (!p?.templateVariant || !Array.isArray(p.results)) return null;
    return p;
  } catch { return null; }
}

// ── DB row → OmrGradeResult (same shape as ResultsPage) ──────────────────────

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function dbRowToOmrResult(row: BatchResultOut): OmrGradeResult & { db_id: number } {
  const debugPaths = parseJson<Record<string, string | null>>(row.debug_paths_json, {});
  return {
    db_id: row.id,
    input: { filename: row.file_name ?? '(unknown)', saved_as: '' },
    student_info: {
      cccd: row.cccd ?? null, sbd: row.sbd ?? null,
      ma_de: row.ma_de ?? null, ca_thi: row.ca_thi ?? null,
      ma_ctdt: null, tu_chon: null,
    },
    answers:            parseJson<Record<string, string | null>>(row.answers_json, {}),
    warnings:           parseJson(row.warnings_json, []),
    info_field_columns: parseJson<InfoFieldColumns | undefined>(row.info_field_columns_json, undefined),
    score: {
      total: row.total_score, max: null, correct: null,
      wrong: null, blank: row.empty_count,
    },
    debug: {
      threshold: 0, mean_mode: '', prep_method: '', alignment_info: '',
      alignment_warnings: [], image_source: null, preprocess_strategy_used: null,
      marker_centers_detected: null, target_marker_centers: null, homography_matrix: null,
      marker_quality_score: null, warp_used: null, warp_rejected_reason: null,
      original_image_path: null, aligned_image_path: null, aligned_candidate_path: null,
      markers_debug_path: null,
      overlay_all_path:         debugPaths['overlay_all_path']         ?? null,
      overlay_marked_only_path: debugPaths['overlay_marked_only_path'] ?? null,
      overlay_warnings_path:    debugPaths['overlay_warnings_path']    ?? null,
      means_json_path: null,
    },
  };
}

/** Classify whether a result needs review */
function needsReview(r: OmrGradeResult, ak: AnswerKeyStore | null): boolean {
  if ((r.warnings ?? []).length > 0) return true;
  const info = r.student_info ?? {};
  const infoFields = [info.cccd, info.sbd, info.ma_de, info.ma_ctdt, info.tu_chon];
  if (infoFields.some(v => v && String(v).includes('_'))) return true;
  if (r._error) return true;
  if (ak) {
    const sc = computeScore(r.answers ?? {}, ak);
    if (sc.blank > 0) return true;
  }
  return false;
}

// ── Edit Modal ────────────────────────────────────────────────────────────────
interface ModalProps {
  r: OmrGradeResult;
  correction: ManualCorrection | undefined;
  onSave: (c: ManualCorrection) => void;
  onReset: () => void;
  onClose: () => void;
}

function EditModal({ r, correction, onSave, onReset, onClose }: ModalProps) {
  const base_info = r.student_info ?? {};
  const base_answers = r.answers ?? {};

  const [info, setInfo] = useState({
    cccd:     String(correction?.corrected_student_info?.cccd    ?? base_info.cccd    ?? ''),
    sbd:      String(correction?.corrected_student_info?.sbd     ?? base_info.sbd     ?? ''),
    ma_de:    String(correction?.corrected_student_info?.ma_de   ?? base_info.ma_de   ?? ''),
    ca_thi:   String(correction?.corrected_student_info?.ca_thi  ?? base_info.ca_thi  ?? ''),
    ma_ctdt:  String(correction?.corrected_student_info?.ma_ctdt ?? base_info.ma_ctdt ?? ''),
    tu_chon:  String(correction?.corrected_student_info?.tu_chon ?? base_info.tu_chon ?? ''),
  });

  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const merged: Record<string, string> = {};
    for (const lbl of ALL_LABELS) {
      merged[lbl] = String(correction?.corrected_answers?.[lbl] ?? base_answers[lbl] ?? '');
    }
    return merged;
  });

  const setAns = (lbl: string, val: string) =>
    setAnswers(prev => ({ ...prev, [lbl]: val === '—' ? '' : val }));

  const handleSave = () => {
    onSave({
      corrected_student_info: info,
      corrected_answers: answers,
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '16px',
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: '#fff', borderRadius: 16,
        width: '90vw', height: '85vh',
        maxWidth: 1400,
        boxShadow: '0 24px 80px rgba(0,0,0,0.28)',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>

        {/* ── Header ── */}
        <div style={{ background: '#C8102E', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <Edit3 size={18} color="#fff" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#fff', fontSize: 15 }}>Sửa thủ công</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 2 }}>{r.input?.filename ?? '—'}</div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 8, cursor: 'pointer', color: '#fff', padding: 7, display: 'flex' }}>
            <X size={18} />
          </button>
        </div>

        {/* ── Sticky action bar — always visible without scrolling ── */}
        <div style={{
          flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 16px',
          background: '#FFF9F9',
          borderBottom: '1px solid #FECACA',
        }}>
          <Button
            icon={<Save size={13} />}
            onClick={handleSave}
            style={{ background: '#C8102E', color: '#fff', borderColor: '#C8102E', fontWeight: 700, fontSize: 12, padding: '6px 14px' }}
          >
            Lưu sửa
          </Button>
          <Button variant="secondary" icon={<RotateCcw size={13} />} onClick={onReset}
            style={{ color: '#6B7280', fontSize: 12, padding: '6px 14px' }}>
            Reset về OMR gốc
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="secondary" onClick={onClose}
            style={{ fontSize: 12, padding: '6px 14px' }}>
            Đóng
          </Button>
        </div>

        {/* ── Body: 2-column grid ── */}
        <div className="edit-modal-body" style={{
          flex: 1, display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          minHeight: 0,
        }}>

          {/* ── Left: form (scrollable) ── */}
          <div style={{
            overflowY: 'auto',
            padding: '20px',
            borderRight: '1px solid #F3F4F6',
            display: 'flex', flexDirection: 'column', gap: 20,
          }}>

            {/* Thông tin sinh viên */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#C8102E', marginBottom: 12 }}>Thông tin sinh viên</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                {([
                  { key: 'cccd',    label: 'CCCD' },
                  { key: 'sbd',     label: 'SBD' },
                  { key: 'ma_de',   label: 'Mã đề' },
                  { key: 'ca_thi',  label: 'Ca thi' },
                  { key: 'ma_ctdt', label: 'Mã CTĐT' },
                  { key: 'tu_chon', label: 'Tự chọn' },
                ] as { key: keyof typeof info; label: string }[]).map(f => (
                  <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7280' }}>{f.label}</label>
                    <input
                      value={info[f.key]}
                      onChange={e => setInfo(prev => ({ ...prev, [f.key]: e.target.value }))}
                      style={{
                        padding: '8px 10px', borderRadius: 8,
                        border: `1.5px solid ${info[f.key].includes('_') ? '#EF4444' : '#E5E7EB'}`,
                        fontSize: 13, fontFamily: 'monospace', outline: 'none',
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Đáp án */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#C8102E', marginBottom: 12 }}>Đáp án</div>
              {Object.entries(SECTION_MAP).map(([section, labels]) => (
                <div key={section} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>{section}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {labels.map((lbl, idx) => {
                      const val = answers[lbl] || '';
                      return (
                        <div key={lbl} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                          <span style={{ fontSize: 9, color: '#9CA3AF' }}>{idx + 1}</span>
                          <select
                            value={val || '—'}
                            onChange={e => setAns(lbl, e.target.value)}
                            style={{
                              padding: '4px 2px', borderRadius: 6, width: 46,
                              border: `1.5px solid ${val ? '#C8102E' : '#E5E7EB'}`,
                              fontSize: 12, fontWeight: 700,
                              color: val ? '#C8102E' : '#9CA3AF',
                              background: val ? '#FEECEC' : '#fff',
                              fontFamily: 'inherit', cursor: 'pointer', outline: 'none', textAlign: 'center',
                            }}
                          >
                            {CHOICES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, paddingTop: 4, borderTop: '1px solid #F3F4F6', marginTop: 'auto' }}>
              <Button
                icon={<Save size={14} />}
                onClick={handleSave}
                style={{ background: '#C8102E', color: '#fff', borderColor: '#C8102E', fontWeight: 700 }}
              >
                Lưu sửa
              </Button>
              <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={onReset} style={{ color: '#6B7280' }}>
                Reset về OMR gốc
              </Button>
              <div style={{ flex: 1 }} />
              <Button variant="secondary" onClick={onClose}>Đóng</Button>
            </div>
          </div>

          {/* ── Right: image viewer ── */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <SheetImageViewer
              debug={r.debug}
              originalFallback={r.input?.saved_as}
              defaultTab="detect"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ReviewErrorsPage() {
  const navigate = useNavigate();

  const [batch,       setBatch]       = useState<BatchGradeState | null>(null);
  const [answerKey,   setAnswerKey]   = useState<AnswerKeyStore | null>(null);
  const [corrections, setCorrections] = useState<CorrectionsStore>({});
  const [selected,    setSelected]    = useState<OmrGradeResult | null>(null);
  const [showAll,     setShowAll]     = useState(false);
  const [loading,     setLoading]     = useState(true);

  // DB-first load: filter by exam_id from localStorage batch if available
  const loadData = useCallback(async () => {
    setAnswerKey(loadAnswerKey());
    setCorrections(loadCorrections());

    // Resolve exam context from localStorage
    const lsBatch = loadBatch();
    const examId  = lsBatch?.examId   ?? null;
    const examName= lsBatch?.examName ?? null;

    try {
      const params: Parameters<typeof resultsApi.list>[0] = { limit: 500 };
      if (examId !== null) params.exam_id = examId;
      const resp = await resultsApi.list(params);
      if (resp.items.length > 0) {
        const converted = resp.items.map(dbRowToOmrResult);
        const first = resp.items[0];
        const syntheticBatch: BatchGradeState = {
          templateVariant: (first.template_variant as BatchGradeState['templateVariant']) ?? 'sbd8',
          results:         converted,
          gradedAt:        first.graded_at,
          examId:          first.exam_id ?? examId,
          examName:        examName,
        };
        setBatch(syntheticBatch);
        setLoading(false);
        return;
      }
    } catch (err) {
      console.warn('[ReviewErrors] DB load failed, fallback localStorage:', err);
    }
    // Fallback: last graded batch from localStorage
    setBatch(lsBatch);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Re-load when user returns from another tab (e.g. ResultsPage)
  useEffect(() => {
    const onFocus = () => { loadData(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadData]);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
        <PageHeader title="Kiểm tra lỗi & Sửa thủ công" subtitle="Đang tải dữ liệu…" />
        <div style={{ padding: '48px 28px', textAlign: 'center', color: '#9CA3AF', fontSize: 13 }}>
          Đang tải kết quả từ database…
        </div>
      </div>
    );
  }

  if (!batch) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
        <PageHeader title="Kiểm tra lỗi & Sửa thủ công" subtitle="Xem và chỉnh sửa các phiếu nhận dạng sai" />
        <div style={{ padding: '48px 28px', textAlign: 'center' }}>
          <AlertTriangle size={40} color="#FCD34D" style={{ margin: '0 auto 16px' }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Chưa có dữ liệu chấm</div>
          <div style={{ fontSize: 13, color: '#9CA3AF', marginBottom: 20 }}>Upload và chấm phiếu trước khi kiểm tra lỗi.</div>
          <Button onClick={() => navigate('/app/upload')}>Quay lại Upload</Button>
        </div>
      </div>
    );
  }

  const safeResults = batch.results ?? [];
  const reviewRows  = safeResults.filter(r => needsReview(r, answerKey));
  const displayRows = showAll ? safeResults : reviewRows;

  const handleSave = (filename: string, c: ManualCorrection) => {
    // 1. localStorage correction (existing flow — always runs)
    const next = { ...corrections, [filename]: c };
    setCorrections(next);
    saveCorrections(next);

    // 2. DB correction (fire-and-forget if result has a db_id)
    const result = safeResults.find(r => (r.input?.filename ?? '') === filename);
    if (result?.db_id) {
      resultsApi.saveCorrection(result.db_id, {
        corrected_answers:      c.corrected_answers,
        corrected_student_info: c.corrected_student_info as Record<string, string>,
        mark_as_reviewed:       true,
      }).catch(err => console.warn('[ReviewErrors] DB correction failed:', err));
    }

    setSelected(null);
  };

  const handleReset = (filename: string) => {
    const next = { ...corrections };
    delete next[filename];
    setCorrections(next);
    saveCorrections(next);
    setSelected(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title={batch.examName ? `Kiểm tra lỗi: ${batch.examName}` : 'Kiểm tra lỗi & Sửa thủ công'}
        subtitle={`${batch.examName ? '' : `Đợt chấm: ${TEMPLATE_VARIANT_LABEL[batch.templateVariant]} · `}${safeResults.length} phiếu`}
        actions={<>
          <Button variant="secondary" size="sm" onClick={() => navigate('/app/results')}>
            Xem Results →
          </Button>
        </>}
      />

      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Summary */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {[
            { label: 'Tổng phiếu',    value: safeResults.length,               accent: '#6366F1' },
            { label: 'Cần xem lại',   value: reviewRows.length,                accent: '#F59E0B' },
            { label: 'Đã sửa tay',    value: Object.keys(corrections).length,  accent: '#10B981' },
            { label: 'Chưa xử lý',    value: reviewRows.filter(r => !corrections[r.input?.filename ?? '']).length, accent: '#C8102E' },
          ].map(s => (
            <Card key={s.label} style={{ borderTop: `3px solid ${s.accent}` }}>
              <div style={{ fontSize: 10, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{s.label}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#1E1E1E' }}>{s.value}</div>
            </Card>
          ))}
        </div>

        {/* Toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>
            {showAll ? `Tất cả phiếu (${safeResults.length})` : `Phiếu cần xem lại (${reviewRows.length})`}
          </span>
          <button
            onClick={() => setShowAll(v => !v)}
            style={{ fontSize: 12, color: '#C8102E', background: 'none', border: '1px solid #FECACA', borderRadius: 9999, padding: '3px 12px', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            {showAll ? 'Chỉ lỗi' : 'Hiện tất cả'}
          </button>
        </div>

        {/* Table */}
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#C8102E' }}>
                  {['STT', 'File', 'CCCD', 'SBD', 'Mã đề', 'Blank', 'Cảnh báo', 'Trạng thái', 'Thao tác'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '10px 10px', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#10B981', fontSize: 13, fontWeight: 600 }}>
                      <CheckCircle2 size={18} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} />
                      Không có phiếu nào cần xem lại!
                    </td>
                  </tr>
                ) : displayRows.map((r, i) => {
                  const filename = r.input?.filename ?? `row-${i}`;
                  const corr = corrections[filename];
                  const sc = answerKey ? computeScore((corr?.corrected_answers ?? r.answers) ?? {}, answerKey) : null;
                  const info = corr ? { ...r.student_info, ...corr.corrected_student_info } : r.student_info;
                  const warnCount = (r.warnings ?? []).length;
                  const hasUnderscore = [info?.cccd, info?.sbd, info?.ma_de].some(v => v && String(v).includes('_'));
                  const isError = !!r._error;

                  return (
                    <tr key={i} style={{
                      borderBottom: '1px solid #F3F4F6',
                      background: isError ? '#FEF2F2' : hasUnderscore ? '#FFFBEB' : warnCount > 0 ? '#FFF9F9' : '#fff',
                    }}>
                      <td style={{ padding: '10px 10px', color: '#9CA3AF' }}>{i + 1}</td>
                      <td style={{ padding: '10px 10px', fontWeight: 600, color: '#1E1E1E', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {filename}
                      </td>
                      <td style={{ padding: '10px 10px', fontFamily: 'monospace', color: (info?.cccd ?? '').includes('_') ? '#EF4444' : '#374151' }}>
                        {info?.cccd ?? '—'}
                      </td>
                      <td style={{ padding: '10px 10px', fontFamily: 'monospace', color: (info?.sbd ?? '').includes('_') ? '#EF4444' : '#374151' }}>
                        {info?.sbd ?? '—'}
                      </td>
                      <td style={{ padding: '10px 10px', fontFamily: 'monospace' }}>{info?.ma_de ?? '—'}</td>
                      <td style={{ padding: '10px 10px', fontWeight: 600, color: sc && sc.blank > 0 ? '#F59E0B' : '#6B7280' }}>
                        {sc ? sc.blank : '—'}
                      </td>
                      <td style={{ padding: '10px 10px' }}>
                        {warnCount > 0
                          ? <span style={{ color: '#B45309', display: 'flex', alignItems: 'center', gap: 3 }}>
                              <AlertTriangle size={11} /> {warnCount}
                            </span>
                          : <span style={{ color: '#9CA3AF' }}>0</span>
                        }
                      </td>
                      <td style={{ padding: '10px 10px' }}>
                        {isError
                          ? <span style={{ color: '#EF4444', fontWeight: 600, fontSize: 11 }}>Lỗi API</span>
                          : corr
                          ? <span style={{ color: '#10B981', fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                              <CheckCircle2 size={11} /> Đã sửa
                            </span>
                          : <span style={{ color: '#F59E0B', fontSize: 11 }}>Cần xem</span>
                        }
                      </td>
                      <td style={{ padding: '10px 10px' }}>
                        <button
                          onClick={() => setSelected(r)}
                          style={{
                            border: '1.5px solid #C8102E', borderRadius: 9999, padding: '4px 12px',
                            background: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
                            color: '#C8102E', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4,
                          }}
                        >
                          <Edit3 size={11} /> Xem & Sửa
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

      </div>

      {/* Edit Modal */}
      {selected && (
        <EditModal
          r={selected}
          correction={corrections[selected.input?.filename ?? '']}
          onSave={c => handleSave(selected.input?.filename ?? '', c)}
          onReset={() => handleReset(selected.input?.filename ?? '')}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
