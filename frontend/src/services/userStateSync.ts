/**
 * userStateSync.ts — keeps the answer-key localStorage entries backed up on
 * the server, per account (2026-09-28).
 *
 * "a lưu đáp án xong đăng xuất ra vào lại thấy mất hết": answer keys used to
 * live ONLY in localStorage, and logout wipes those keys on purpose
 * (providers.tsx — shared computers). Every page still reads/writes
 * localStorage synchronously exactly as before; this module just:
 *   - hydrateUserState(): after login / page load, copies the server's values
 *     into localStorage (and uploads any local-only value — answer keys saved
 *     before this fix existed);
 *   - markUserStateDirty(key): called by grading.ts on every save, uploads the
 *     key a moment later;
 *   - flushUserState(): uploads pending keys immediately (used on logout,
 *     BEFORE localStorage is cleared).
 *
 * Uploads are held back until one hydrate has succeeded: otherwise a save made
 * while the server copy wasn't loaded yet (e.g. network down at login) would
 * replace the whole server-side drafts/library map with a partial one.
 */
import { userStateApi } from './apiClient';

/** Must match ALLOWED_KEYS in backend/app/api/v1/routes/user_state.py */
export const SYNCED_KEYS = [
  'vju_answer_key',
  'vju_answer_key_drafts',
  'vju_answer_key_library',
  'vju_last_template',
] as const;

type SyncedKey = typeof SYNCED_KEYS[number];

const pending = new Set<SyncedKey>();
let hydrated = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function isSynced(key: string): key is SyncedKey {
  return (SYNCED_KEYS as readonly string[]).includes(key);
}

function readLocal(key: SyncedKey): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function schedule(delayMs: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void flushUserState(); }, delayMs);
}

export function markUserStateDirty(key: string): void {
  if (!isSynced(key)) return;
  pending.add(key);
  if (hydrated) schedule(800);
}

/** Upload every pending key now. Values (and the auth token, inside
 *  request()) are captured synchronously, so calling this right before
 *  logout clears localStorage is safe. */
export function flushUserState(opts: { keepalive?: boolean } = {}): Promise<void> {
  if (!hydrated || pending.size === 0) return Promise.resolve();
  const batch = [...pending].map(key => ({ key, raw: readLocal(key) }));
  pending.clear();
  return Promise.all(batch.map(({ key, raw }) =>
    userStateApi.put(key, raw ?? 'null', opts.keepalive).catch(() => {
      // Keep it for the next attempt unless a newer save already queued it
      if (!pending.has(key)) pending.add(key);
      schedule(10_000);
    }),
  )).then(() => undefined);
}

/** Load this account's server copy into localStorage. Resolves once done
 *  (or failed — the app then keeps working from localStorage and retries). */
export async function hydrateUserState(): Promise<void> {
  hydrated = false;
  try {
    const server = await userStateApi.get();
    for (const key of SYNCED_KEYS) {
      if (pending.has(key)) continue;   // changed locally while we were loading
      if (key in server) {
        try { localStorage.setItem(key, JSON.stringify(server[key])); } catch { /* ignore */ }
      } else if (readLocal(key) != null) {
        pending.add(key);               // local-only data from before the server copy existed
      }
    }
    hydrated = true;
    if (pending.size) schedule(0);
  } catch {
    setTimeout(() => { if (!hydrated) void hydrateUserState(); }, 10_000);
  }
}

/** Forget sync state on logout (after flushUserState()). */
export function resetUserStateSync(): void {
  hydrated = false;
  pending.clear();
  if (timer) { clearTimeout(timer); timer = null; }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { void flushUserState({ keepalive: true }); });
}
