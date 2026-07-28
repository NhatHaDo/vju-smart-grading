/**
 * templateSchema.ts — Shared utilities for building TemplateSchema from API detail.
 * Used by TemplatePage and SheetReviewPage.
 */
import type { CustomFormDetail } from '../services/apiClient';
import type { BatchGradeState, OmrGradeResult, TemplateSchema } from '../types/grading';
import { TEMPLATE_VARIANT_LABEL } from '../types/grading';

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
 *  (e.g. rows from a freshly-graded batch that hasn't round-tripped the DB). */
export function getRowTemplateKey(r: OmrGradeResult, fallbackBatch?: BatchGradeState | null): string {
  const ttype = r.template_type ?? (fallbackBatch?.templateMode === 'custom' ? 'custom' : 'vju');
  if (ttype === 'custom') {
    const tid = r.template_id ?? fallbackBatch?.customTemplateId ?? null;
    return `custom:${tid ?? 'unknown'}`;
  }
  const tvar = r.template_variant_row ?? fallbackBatch?.templateVariant ?? 'sbd8';
  return `vju:${tvar}`;
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
    return name ? `Custom - ${name}` : `Custom #${tid ?? '?'}`;
  }
  const tvar = r.template_variant_row ?? fallbackBatch?.templateVariant ?? 'sbd8';
  return TEMPLATE_VARIANT_LABEL[tvar as keyof typeof TEMPLATE_VARIANT_LABEL] ?? tvar.toUpperCase();
}
