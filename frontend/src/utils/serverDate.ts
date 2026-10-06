/**
 * serverDate.ts — read a time sent by the server (2026-10-07)
 *
 * "sao cái giờ này nó ko đúng nhỉ ? (t đang là giờ kia)": the server keeps
 * times in UTC but sends them without a time zone ("2026-10-06T17:57:00"),
 * and a browser reads such a string as LOCAL time — so every time showed
 * 7 hours early in Việt Nam (17:57 instead of 00:57 the next day). A string
 * with no zone is read as UTC here; one that has a zone ("Z", "+07:00") is
 * read as it says.
 */
export function serverDate(value: string | number | Date | null | undefined): Date {
  if (value instanceof Date || typeof value === 'number') return new Date(value);
  const s = (value ?? '').trim();
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  return new Date(naive ? `${s.replace(' ', 'T')}Z` : s);
}
