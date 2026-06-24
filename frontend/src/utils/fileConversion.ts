/**
 * fileConversion.ts — normalize upload files before sending to OMR API.
 * Converts HEIC/HEIF → JPEG (browser-side via heic2any).
 */

const HEIC_EXTS = ['.heic', '.heif'];

export function isHeicFile(file: File): boolean {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  return HEIC_EXTS.includes(ext) || file.type === 'image/heic' || file.type === 'image/heif';
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/** Convert a HEIC/HEIF File to a JPEG File using heic2any (dynamic import). */
export async function convertHeicToJpeg(file: File): Promise<File> {
  // Dynamic import to avoid SSR / build issues with heic2any
  const heic2any = (await import('heic2any')).default;
  const blob = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.92,
  }) as Blob;
  // heic2any may return Blob | Blob[]
  const single = Array.isArray(blob) ? blob[0] : blob;
  const baseName = file.name.replace(/\.[^.]+$/, '');
  return new File([single], `${baseName}.jpg`, { type: 'image/jpeg' });
}

export type NormalizeResult =
  | { ok: true;  file: File }
  | { ok: false; error: string };

/**
 * Normalize a file for OMR upload:
 * - HEIC/HEIF → convert to JPEG
 * - PDF      → return error (not supported in single-image endpoint)
 * - Others   → pass through
 */
export async function normalizeUploadFile(file: File): Promise<NormalizeResult> {
  if (isPdfFile(file)) {
    return {
      ok: false,
      error: 'PDF sẽ được hỗ trợ ở batch flow sau. Vui lòng dùng JPG/PNG/HEIC.',
    };
  }
  if (isHeicFile(file)) {
    try {
      const converted = await convertHeicToJpeg(file);
      return { ok: true, file: converted };
    } catch (err) {
      return {
        ok: false,
        error: `Không thể chuyển HEIC sang JPG: ${String(err).slice(0, 120)}`,
      };
    }
  }
  return { ok: true, file };
}
