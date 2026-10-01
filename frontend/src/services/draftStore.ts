/**
 * draftStore.ts — keeps half-done work when the teacher switches page
 * (2026-10-01).
 *
 * "khi t chuyển các tab khác thì tab t đang dở bị mất": Trộn đề and the
 * ngân hàng import lost the chosen file and every đáp án picked by hand as
 * soon as the page unmounted. Two layers, nothing stored on the server:
 *
 *   - useDraft(key, init): useState kept in this module's memory, so it
 *     survives navigating between pages (File objects included). Gone on
 *     reload / logout: nothing to clean up.
 *   - picked answers: also saved in localStorage per file (name, size, date),
 *     so after a reload, choosing the same file again brings the picks back.
 *     Small and self-cleaning: at most MAX_FILES files, dropped after MAX_AGE,
 *     removed once the đề is mixed / the file imported, wiped on logout.
 */
import { useCallback, useState } from 'react';

const memory = new Map<string, unknown>();

/** useState that outlives the page. `key` undefined → plain useState. */
export function useDraft<T>(key: string | undefined, init: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    if (key && memory.has(key)) return memory.get(key) as T;
    return typeof init === 'function' ? (init as () => T)() : init;
  });
  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue(prev => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      if (key) memory.set(key, v);
      return v;
    });
  }, [key]);
  return [value, set] as const;
}

/** Forget every draft whose key starts with `prefix` (all of them when omitted). */
export function clearDrafts(prefix = '') {
  for (const k of [...memory.keys()]) if (k.startsWith(prefix)) memory.delete(k);
}

// ── Picked answers, per file ────────────────────────────────────────────────

export const PICKED_LS_KEY = 'vju_picked_answers';
const MAX_FILES = 10;
const MAX_AGE = 14 * 24 * 3600 * 1000;

type PickedStore = Record<string, { at: number; picked: Record<number, number> }>;

/** Same file(s) chosen again ↔ same key. */
export function filesSignature(files: File[]) {
  return files.map(f => `${f.name}/${f.size}/${f.lastModified}`).join('|');
}

function readStore(): PickedStore {
  try {
    const s = JSON.parse(localStorage.getItem(PICKED_LS_KEY) || '{}') as PickedStore;
    const now = Date.now();
    for (const k of Object.keys(s)) if (!(now - s[k].at < MAX_AGE)) delete s[k];
    return s;
  } catch { return {}; }
}

function writeStore(s: PickedStore) {
  const keys = Object.keys(s).sort((a, b) => s[b].at - s[a].at);
  for (const k of keys.slice(MAX_FILES)) delete s[k];
  try {
    if (Object.keys(s).length) localStorage.setItem(PICKED_LS_KEY, JSON.stringify(s));
    else localStorage.removeItem(PICKED_LS_KEY);
  } catch { /* storage full or blocked: picks just aren't kept */ }
}

export function loadPicked(sig: string): Record<number, number> {
  return (sig && readStore()[sig]?.picked) || {};
}

export function savePicked(sig: string, picked: Record<number, number>) {
  if (!sig) return;
  const s = readStore();
  if (Object.keys(picked).length) s[sig] = { at: Date.now(), picked };
  else delete s[sig];
  writeStore(s);
}
