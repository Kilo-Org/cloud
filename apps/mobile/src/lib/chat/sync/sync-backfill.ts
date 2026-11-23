import { type UploadOutcome } from './sync-engine';

/**
 * Backfill: the chats that existed before sync existed, uploaded in the
 * background one chat at a time. It never touches the UI thread's turn and
 * never runs two chats at once, and it re-reads the setting before every
 * request so turning sync off stops it before the next one. A chat the
 * service cannot take yet is retried with a growing delay instead of spinning.
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

type Run = {
  readonly deps: BackfillDeps;
  readonly attempts: number;
  readonly base: number;
  readonly cap: number;
  uploaded: number;
};

/**
 * One chat, retried up to `attempts` times with doubling delays. Answers the
 * run's own verdict for this chat: `Next` to move on, `Stop` when the person
 * turned sync off, `Park` when the service keeps refusing.
 */
type ChatResult = 'next' | 'stop' | 'park';
type Verdict = ChatResult | 'retry';

async function uploadOne(run: Run, sessionId: string): Promise<Verdict> {
  const { deps } = run;
  const outcome = await deps.upload(sessionId);
  if (outcome.kind === 'synced') {
    run.uploaded += 1;
    return 'next';
  }
  // Nothing to send, a tombstone, a divergence, or a refusal no retry fixes:
  // the chat's own next exchange settles it.
  if (outcome.kind !== 'pending') {
    return 'next';
  }
  return 'retry';
}

/** Retries one chat `attempts` times, doubling the wait between tries. */
async function retryChat(input: {
  readonly run: Run;
  readonly sessionId: string;
  readonly attempt: number;
  readonly delay: number;
}): Promise<Verdict> {
  const { run, sessionId, attempt, delay } = input;
  if (attempt > run.attempts) {
    return 'park';
  }
  const verdict = await uploadOne(run, sessionId);
  if (verdict !== 'retry') {
    return verdict;
  }
  if (attempt === run.attempts) {
    return 'park';
  }
  await run.deps.wait(delay);
  if (!(await run.deps.stillOn())) {
    return 'stop';
  }
  return retryChat({ run, sessionId, attempt: attempt + 1, delay: Math.min(run.cap, delay * 2) });
}

/** Uploads each chat in order, one at a time. */
async function eachChat(run: Run, index: number): Promise<BackfillOutcome> {
  const chats = run.deps.pending();
  if (index >= chats.length) {
    return { kind: 'done', uploaded: run.uploaded };
  }
  if (!(await run.deps.stillOn())) {
    return { kind: 'stopped', uploaded: run.uploaded };
  }
  const verdict = await retryChat({
    run,
    sessionId: chats[index] as string,
    attempt: 1,
    delay: run.base,
  });
  if (verdict === 'stop') {
    return { kind: 'stopped', uploaded: run.uploaded };
  }
  if (verdict === 'park') {
    return { kind: 'parked', uploaded: run.uploaded };
  }
  return eachChat(run, index + 1);
}

/**
 * Uploads `deps.pending()` one chat at a time. Answers `stopped` the moment
 * the setting is off, `parked` when a chat keeps refusing after its
 * attempts, `done` when every chat either reached the server or was skipped
 * for a reason no retry fixes.
 */
export function runBackfill(deps: BackfillDeps): Promise<BackfillOutcome> {
  const run: Run = {
    deps,
    attempts: deps.attemptsPerChat ?? DEFAULTS.attemptsPerChat,
    base: deps.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
    cap: deps.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
    uploaded: 0,
  };
  return eachChat(run, 0);
}
