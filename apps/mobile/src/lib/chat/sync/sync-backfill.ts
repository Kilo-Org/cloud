import  { type UploadOutcome } from './sync-engine';

/**
 * Backfill: the chats that existed before sync was available, uploaded in
 * the background one chat at a time. It never touches the UI thread's turn,
 * never runs two chats at once, and re-reads the setting before every request
 * so turning sync off stops it before the next one. A chat the service
 * cannot take yet parks with a growing delay instead of spinning.
 */

export type BackfillDeps = {
  /** Local chats that have not reached the server yet, oldest first. */
  readonly pending: () => readonly string[];
  readonly upload: (sessionId: string) => Promise<UploadOutcome>;
  /** Re-read before each request: false stops the run immediately. */
  readonly stillOn: () => Promise<boolean>;
  readonly wait: (ms: number) => Promise<void>;
  /** How many times one chat is retried inside one run before it is parked. */
  readonly attemptsPerChat?: number;
  /** The first backoff step, doubling up to `maxBackoffMs`. */
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
};

export type BackfillOutcome =
  | { readonly kind: 'done'; readonly uploaded: number }
  | { readonly kind: 'stopped'; readonly uploaded: number }
  | { readonly kind: 'parked'; readonly uploaded: number };

const DEFAULTS = { attemptsPerChat: 3, baseBackoffMs: 2_000, maxBackoffMs: 60_000 };

/**
 * Uploads `deps.pending()` one chat at a time. Answers `stopped` the moment
 * the setting is off, `parked` when a chat keeps refusing after its
 * attempts, `done` when every chat either reached the server or was skipped
 * for a reason no retry fixes (a tombstone, a divergence).
 */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillOutcome> {
  const attempts = deps.attemptsPerChat ?? DEFAULTS.attemptsPerChat;
  const base = deps.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
  const cap = deps.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  let uploaded = 0;
  for (const sessionId of deps.pending()) {
    if (!(await deps.stillOn())) {
      return { kind: 'stopped', uploaded };
    }
    let delay = base;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const outcome = await deps.upload(sessionId);
      if (outcome.kind === 'synced') {
        uploaded += 1;
        break;
      }
      if (outcome.kind === 'nothing-to-upload') {
        break;
      }
      if (outcome.kind !== 'pending') {
        // Diverged, deleted, or refused for a reason a retry cannot fix: leave
        // it alone here; the chat's own next exchange settles it.
        break;
      }
      if (attempt === attempts) {
        return { kind: 'parked', uploaded };
      }
      await deps.wait(delay);
      delay = Math.min(cap, delay * 2);
      if (!(await deps.stillOn())) {
        return { kind: 'stopped', uploaded };
      }
    }
  }
  return { kind: 'done', uploaded };
}
