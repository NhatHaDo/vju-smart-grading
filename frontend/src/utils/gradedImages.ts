/**
 * gradedImages.ts — tải ảnh đã chấm (2026-10-06)
 *
 * anh Tú: "thêm nút tải ảnh xuống để tải ảnh này về" + "gửi ảnh các bài";
 * then "t ko thấy nút tải về ảnh ở đâu" — the graded picture (green/red marks,
 * score in the corner) of one bài or of several, from Chấm nhanh, the Kết quả
 * page and a bài's detail window.
 *
 * Teachers use phones, often inside another app's browser (Zalo, the Google
 * app…) where a plain file download does nothing. So on a phone the pictures
 * go through the share sheet (iPhone/Android: "Lưu hình ảnh" puts them in
 * Ảnh/Gallery, or send them on Zalo straight away); elsewhere they download —
 * one .jpg, or a .zip for several.
 */
import { saveAs } from 'file-saver';
import type { OmrGradeResult } from '../types/grading';

/** Same rule as SheetImageViewer: the debug path → a URL the page can fetch. */
export function debugImageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  const norm = path.replace(/\\/g, '/');
  const idx = Math.max(norm.lastIndexOf('outputs/'), norm.lastIndexOf('uploads/'));
  const relative = idx >= 0 ? norm.slice(idx) : norm.replace(/^\//, '');
  const base = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
  return `${base}/${relative}`;
}

/** The graded picture of a bài: marks drawn on the straightened sheet. */
export function gradedImageUrl(r: OmrGradeResult): string | null {
  return debugImageUrl(r.debug?.overlay_all_path ?? r.debug?.aligned_image_path);
}

function scoreOn10(r: OmrGradeResult): number | null {
  const { total, max } = r.score ?? {};
  if (total == null || max == null || max <= 0) return null;
  return Math.round((total / max) * 10 * 100) / 100;
}

/** "SBD 123456 - Ma de 101 - 8.5 diem.jpg" — whatever the sheet read in full. */
export function gradedImageName(r: OmrGradeResult, index?: number): string {
  const parts: string[] = [];
  if (index != null) parts.push(String(index + 1).padStart(2, '0'));
  // only fully read numbers ("_" = a column left blank or unreadable)
  const ok = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !v.includes('_');
  const info = (r.student_info ?? {}) as Record<string, unknown>;
  const sbd = [info.sbd, info.cccd].find(ok);
  const maDe = [info.ma_de, info.made].find(ok);
  if (sbd) parts.push(`SBD ${sbd}`);
  if (maDe) parts.push(`Ma de ${maDe}`);
  if (!sbd && !maDe) {
    // custom templates key their fields by block name (Mẫu 40: mã SV, mã đề)
    parts.push(...Object.values(info).filter(ok).slice(0, 2));
  }
  const d = scoreOn10(r);
  if (d != null) parts.push(`${d} diem`);
  if (parts.length === (index != null ? 1 : 0)) parts.push('bai cham');
  return `${parts.join(' - ').replace(/[\\/:*?"<>|]+/g, '_')}.jpg`;
}

async function fetchBlob(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.blob() : null;
  } catch { return null; }
}

function canShareFiles(files: File[]): boolean {
  try {
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    return typeof nav.share === 'function' && !!nav.canShare?.({ files });
  } catch { return false; }
}

const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches;

/**
 * Save the graded pictures of these bài. Returns how many were saved, or
 * throws an Error whose message can be shown to the teacher.
 */
export async function saveGradedImages(results: OmrGradeResult[], zipName = 'Anh bai cham'): Promise<number> {
  const files: File[] = [];
  for (let i = 0; i < results.length; i++) {
    const url = gradedImageUrl(results[i]);
    const blob = url ? await fetchBlob(url) : null;
    if (blob) {
      files.push(new File([blob], gradedImageName(results[i], results.length > 1 ? i : undefined),
        { type: blob.type || 'image/jpeg' }));
    }
  }
  if (files.length === 0) throw new Error('Không có ảnh nào để tải (bài chưa có ảnh đã chấm).');

  // phones: the share sheet → "Lưu hình ảnh" / Zalo
  if (isPhone() && canShareFiles(files)) {
    try {
      await navigator.share({ files, title: files.length === 1 ? files[0].name : `${files.length} ảnh bài chấm` });
      return files.length;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return 0;     // the teacher closed the sheet
      // otherwise fall through to a normal download
    }
  }
  if (files.length === 1) {
    saveAs(files[0], files[0].name);
    return 1;
  }
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f);
  const ts = new Date();
  const pad = (x: number) => String(x).padStart(2, '0');
  saveAs(await zip.generateAsync({ type: 'blob' }),
    `${zipName} ${pad(ts.getDate())}-${pad(ts.getMonth() + 1)} ${pad(ts.getHours())}h${pad(ts.getMinutes())}.zip`);
  return files.length;
}
