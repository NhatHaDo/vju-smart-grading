/**
 * templateSchema.ts — Shared utilities for building TemplateSchema from API detail.
 * Used by TemplatePage and SheetReviewPage.
 */
import type { CustomFormDetail } from '../services/apiClient';
import type { BatchGradeState, OmrGradeResult, TemplateSchema } from '../types/grading';
import { TEMPLATE_VARIANT_LABEL, VJU_PRESET_SCHEMA } from '../types/grading';

/**
 * Returns true if a custom-form area should be treated as an MCQ answer field.
 * An area is an answer field when includeInAnswerKey is true (the default for MCQ4).
 */
export function isAnswerField(area: { includeInAnswerKey?: boolean; fieldType?: string }): boolean {
  if ('includeInAnswerKey' in area) return Boolean(area.includeInAnswerKey);
  // Infer from fieldType: MCQ variants are answer fields, INT variants are not
  const ft = (area.fieldType ?? '').toUpperCase();
  return ft.startsWith('QTYPE_MCQ') || ft === 'QTYPE_TRUE_FALSE' || ft === 'QTYPE_YES_NO';
}

/**
 * Returns true if a custom-form area should be treated as an info (non-answer) field.
 * Info fields are INT fields where includeInAnswerKey is false.
 */
export function isInfoField(area: { includeInAnswerKey?: boolean; fieldType?: string }): boolean {
  return !isAnswerField(area);
}

/**
 * Convert a GET /custom-forms/{id} response into a TemplateSchema
 * that drives dynamic columns, answer sections, and modal headers.
 */
export function buildSchemaFromDetail(detail: CustomFormDetail): TemplateSchema {
  const infoFields = (detail.infoFields ?? []).map(f => ({
    key:         f.key,
    displayName: f.displayName || f.key,
  }));

  // Group answer fields by blockName into sections. Composite fields (e.g. the
  // signed-decimal field type) each get their own blockName === their key, so
  // they naturally end up as a dedicated single-label section — just marked
  // inputType: 'text' so the UI renders a text box instead of an A/B/C/D grid.
  const sectionMap = new Map<string, { name: string; labels: string[]; inputType?: 'mcq' | 'text'; options?: string[] }>();
  for (const af of (detail.answerFields ?? [])) {
    const key = af.blockName;
    if (!sectionMap.has(key)) {
      // Prefer the user-given block display name (e.g. "TN1") over the
      // per-question "Câu N" label, which used to leak through here and
      // make every section look like it was named after its first question.
      sectionMap.set(key, {
        name: af.blockLabel || af.label || af.blockName,
        labels: [],
        inputType: af.composite ? 'text' : 'mcq',
        // e.g. ["A","B","C","D"] or ["Đ","S"] — every field in one block
        // shares the same bubbleValues, so the first entry's options apply
        // to the whole section (drives the dropdown choices in the UI).
        options: af.options && af.options.length > 0 ? af.options : undefined,
      });
    }
    sectionMap.get(key)!.labels.push(af.key);
  }
  const answerSections = Array.from(sectionMap.values()).filter(s => s.labels.length > 0);

  return { infoFields, answerSections };
}

/**
 * Derive a minimal TemplateSchema from raw answer keys when the real schema is unavailable.
 * Groups labels by common prefix (e.g. "q1","q2" → section "q", "toan1" → section "toan").
 * Falls back to a single "Câu hỏi" section if no prefix pattern found.
 */
export function buildSchemaFromAnswerKeys(answerKeys: string[]): TemplateSchema {
  if (answerKeys.length === 0) return { infoFields: [], answerSections: [] };
  const prefixMap = new Map<string, string[]>();
  for (const key of answerKeys) {
    const m = key.match(/^([a-zA-Z_]+)\d+$/);
    const prefix = m ? m[1] : '__default__';
    if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
    prefixMap.get(prefix)!.push(key);
  }
  const answerSections = Array.from(prefixMap.entries()).map(([prefix, labels]) => ({
    name:   prefix === '__default__' ? 'Câu hỏi' : prefix.replace(/_/g, ' '),
    labels: labels.sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10);
      const nb = parseInt(b.replace(/\D/g, ''), 10);
      return na - nb;
    }),
  }));
  return { infoFields: [], answerSections };
}

// ── Per-row template identification (2026-07-29) ────────────────────────────
// Moved here from ResultsPage.tsx so ExcelPreviewPage can build the same
// "which template does this row belong to" grouping when the user picks a
// different kỳ thi/mẫu phiếu on the export-preview page itself, instead of
// only ever reflecting whatever ResultsPage last had selected. Single source
// of truth — ResultsPage now imports these instead of keeping its own copy.

export type TemplateFilterOption = {
  key:            string;
  label:          string;
  templateMode:   'vju' | 'custom';
  templateId?:    number | null;
  templateSchema: TemplateSchema;
};

/** Stable per-row key identifying which template a DB/localStorage row belongs
 *  to — "vju:sbd8" or "custom:123". Falls back to the parent batch's own
 *  template when the row itself doesn't carry template_type/template_id
 *  (e.g. rows from a freshly-graded batch that hasn't round-tripped the DB).
 *
 *  2026-07-29 fix: rows whose `template_type` is missing (older DB rows saved
 *  before this column was tracked) used to silently default to 'vju', which
 *  force-fit the row into the fixed 6-field VJU schema (CCCD/SBD/Mã đề/Ca
 *  thi/Mã CTĐT/Tự chọn) even when the row was actually graded with a
 *  different custom form. The export then showed the wrong column headers
 *  and "—" for every info cell, because the row's real values are stored
 *  under that form's own field keys, not VJU's. We now only trust the
 *  fallback batch when it's explicitly describing this row set; otherwise
 *  we bucket the row as "custom:unknown" so the caller can build a schema
 *  from the row's own data instead of guessing wrong. */
export function getRowTemplateKey(r: OmrGradeResult, fallbackBatch?: BatchGradeState | null): string {
  if (r.template_type === 'custom') {
    const tid = r.template_id ?? fallbackBatch?.customTemplateId ?? null;
    return `custom:${tid ?? 'unknown'}`;
  }
  if (r.template_type === 'vju') {
    const tvar = r.template_variant_row ?? fallbackBatch?.templateVariant ?? 'sbd8';
    return `vju:${tvar}`;
  }
  // r.template_type is missing — only trust fallbackBatch if it actually
  // claims a mode; never assume 'vju' just because it's the default.
  if (fallbackBatch?.templateMode === 'custom') {
    return `custom:${fallbackBatch.customTemplateId ?? 'unknown'}`;
  }
  if (fallbackBatch?.templateMode === 'vju') {
    return `vju:${fallbackBatch.templateVariant ?? 'sbd8'}`;
  }
  return 'custom:unknown';
}

/** Human-readable label for getRowTemplateKey()'s bucket, e.g. "Mẫu phiếu VJU
 *  - SBD 8 số" or "Custom - temp3". templateNames maps custom template id →
 *  real saved name (from customFormsApi.get()), used when the batch itself
 *  doesn't carry customTemplateName (true for any batch reloaded from DB). */
export function getRowTemplateLabel(
  r: OmrGradeResult,
  fallbackBatch?: BatchGradeState | null,
  templateNames?: Map<number, string>,
): string {
  const key = getRowTemplateKey(r, fallbackBatch);
  if (key.startsWith('custom:')) {
    const tid = r.template_id ?? fallbackBatch?.customTemplateId ?? null;
    const name = fallbackBatch?.customTemplateName ?? (tid != null ? templateNames?.get(tid) : null) ?? null;
    if (name) return `Custom - ${name}`;
    if (tid != null) return `Custom #${tid}`;
    return 'Không rõ mẫu phiếu (dữ liệu cũ)';
  }
  const tvar = r.template_variant_row ?? fallbackBatch?.templateVariant ?? 'sbd8';
  return TEMPLATE_VARIANT_LABEL[tvar as keyof typeof TEMPLATE_VARIANT_LABEL] ?? tvar.toUpperCase();
}

/** Build a fallback TemplateSchema by inspecting the union of keys actually
 *  present across a set of rows whose real template is unresolvable (the
 *  "custom:unknown" bucket above). Produces sensible-looking column labels
 *  from the row's own data instead of showing an empty/wrong schema. */
export function buildInferredSchemaForRows(rows: OmrGradeResult[]): TemplateSchema {
  const KNOWN_LABELS: Record<string, string> = {
    cccd: 'CCCD', sbd: 'SBD', ma_de: 'Mã đề', ca_thi: 'Ca thi',
    ma_ctdt: 'Mã CTĐT', tu_chon: 'Tự chọn',
  };
  const infoKeys = new Set<string>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.student_info ?? {})) {
      if (v != null && String(v).trim() !== '') infoKeys.add(k);
    }
  }
  const infoFields = [...infoKeys].sort().map(key => ({
    key,
    displayName: KNOWN_LABELS[key] ?? key,
  }));

  const answerKeys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.answers ?? {})) answerKeys.add(k);
  const { answerSections } = buildSchemaFromAnswerKeys([...answerKeys]);

  return { infoFields, answerSections };
}

/** Group a flat list of rows into per-template TemplateFilterOptions, ready
 *  for a template-picker dropdown or an export builder. Single source of
 *  truth shared by ResultsPage and ExcelPreviewPage (2026-07-29) so both
 *  pages resolve "which schema does this row actually use" the same way —
 *  including the custom:unknown fallback above. */
export function buildTemplateOptionsFromRows(
  rows: OmrGradeResult[],
  fallbackBatch: BatchGradeState | null | undefined,
  fetchedSchemas: Map<number, TemplateSchema>,
  templateNames?: Map<number, string>,
): TemplateFilterOption[] {
  const seen = new Map<string, TemplateFilterOption>();
  const rowsByKey = new Map<string, OmrGradeResult[]>();

  for (const r of rows) {
    const key = getRowTemplateKey(r, fallbackBatch);
    const bucket = rowsByKey.get(key);
    if (bucket) bucket.push(r); else rowsByKey.set(key, [r]);

    if (!seen.has(key)) {
      const isCustom = key.startsWith('custom:');
      const tid = isCustom ? (r.template_id ?? fallbackBatch?.customTemplateId ?? null) : null;
      const knownSchema: TemplateSchema | null = isCustom
        ? (fallbackBatch?.templateSchema && fallbackBatch.customTemplateId === tid
            ? fallbackBatch.templateSchema
            : (tid != null && fetchedSchemas.has(tid) ? fetchedSchemas.get(tid)! : null))
        : VJU_PRESET_SCHEMA;
      seen.set(key, {
        key,
        label:          getRowTemplateLabel(r, fallbackBatch, templateNames),
        templateMode:   isCustom ? 'custom' : 'vju',
        templateId:     tid,
        // Placeholder when knownSchema is null — patched below from the
        // bucket's own rows once every row has been grouped.
        templateSchema: knownSchema ?? { infoFields: [], answerSections: [] },
      });
    }
  }

  for (const [key, opt] of seen) {
    if (opt.templateMode === 'custom' && opt.templateId == null) {
      opt.templateSchema = buildInferredSchemaForRows(rowsByKey.get(key) ?? []);
    }
  }

  return Array.from(seen.values());
}
