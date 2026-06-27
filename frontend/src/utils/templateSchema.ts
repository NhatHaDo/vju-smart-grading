/**
 * templateSchema.ts — Shared utilities for building TemplateSchema from API detail.
 * Used by TemplatePage and SheetReviewPage.
 */
import type { CustomFormDetail } from '../services/apiClient';
import type { TemplateSchema } from '../types/grading';

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

  // Group non-composite MCQ answer fields by blockName into sections
  const sectionMap = new Map<string, { name: string; labels: string[] }>();
  for (const af of (detail.answerFields ?? [])) {
    if (af.composite) continue;
    const key = af.blockName;
    if (!sectionMap.has(key)) {
      sectionMap.set(key, { name: af.label || af.blockName, labels: [] });
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
