import { type SessionAttentionHydration } from '@/lib/session-attention';
import { SESSION_ATTENTION_KEY } from '@/lib/storage-keys';

/**
 * The ack store's two decisions, restated over a caller-supplied phase so a
 * suite can present the store as still loading or as settled.
 *
 * A suite that mounts a surface reading the ack store needs to control that
 * store's phase, and the phase is what the surface's behaviour turns on: held
 * while `loading`, answered from the status and the ack once settled. Keeping
 * the rule in one place means the fake cannot drift from the shipped one in the
 * way that makes a hold assertion pass for the wrong reason.
 *
 * `failed` answers exactly as `ready` does — an ack this run recorded still
 * hides its raise, and with no ack the status alone decides.
 *
 * The bottom half is the in-memory `@/lib/persist/encrypted-kv` double the same
 * suites mock, with a gate over the hydration read so a case can hold the store
 * in `loading` and prove a derive waits for it (or still derives after the
 * bounded deadline).
 */
function waitsForInput(status: string | null | undefined): boolean {
  return status === 'question' || status === 'permission';
}

export function fakeNeedsInputVisibility(input: {
  status: string | null | undefined;
  hydration: SessionAttentionHydration;
  isAcked: boolean;
}): 'show' | 'hold' | 'hide' {
  if (input.hydration === 'loading') {
    return 'hold';
  }
  if (!waitsForInput(input.status)) {
    return 'hide';
  }
  return input.isAcked ? 'hide' : 'show';
}

export function fakeShouldShowNeedsInput(input: {
  status: string | null | undefined;
  hydration: SessionAttentionHydration;
  isAcked: boolean;
}): boolean {
  return fakeNeedsInputVisibility(input) === 'show';
}

export function fakeSessionNeedsInput(status: string | null | undefined): boolean {
  return waitsForInput(status);
}

// ── Encrypted-KV double ─────────────────────────────────────────────────────

const kvCells = new Map<string, string>();

/** Mirrors the ack store's single-blob item key (`session-attention.ts`). */
const ATTENTION_ENTRY_KEY = 'entries';

/** The ack store's one hydration read, held open until its release runs. */
let readGate: { readonly promise: Promise<void>; readonly release: () => void } | null = null;

function kvKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

/**
 * Mock `@/lib/persist/encrypted-kv` with this object so the real ack store
 * hydrates from memory instead of the native SQLCipher chain, which cannot load
 * in a node test environment.
 */
export const sessionAttentionKvFake = {
  getItem: async (scope: string, key: string): Promise<string | null> => {
    const gate = readGate;
    if (gate !== null) {
      await gate.promise;
    }
    return kvCells.get(kvKey(scope, key)) ?? null;
  },
  setItem: (scope: string, key: string, value: string): Promise<void> => {
    kvCells.set(kvKey(scope, key), value);
    return Promise.resolve();
  },
  clearScope: (scope: string): Promise<void> => {
    for (const key of kvCells.keys()) {
      if (key.startsWith(`${scope}\u0000`)) {
        kvCells.delete(key);
      }
    }
    return Promise.resolve();
  },
};

/**
 * Seed the entries blob an earlier launch persisted, so the next hydration read
 * restores those answers.
 */
export function seedSessionAttentionKvFake(entries: readonly unknown[]): void {
  kvCells.set(kvKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY), JSON.stringify(entries));
}

/**
 * Hold the ack store's next hydration read until the returned release runs, so
 * the store stays `loading` for as long as the case needs. The release is
 * idempotent.
 */
export function gateSessionAttentionKvRead(): () => void {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  const release = (): void => {
    if (readGate === gate) {
      readGate = null;
    }
    resolve(undefined);
  };
  const gate = { promise, release };
  readGate = gate;
  return release;
}

/** Clear the cells and open any held read, so one case cannot leak into the next. */
export function resetSessionAttentionKvFake(): void {
  kvCells.clear();
  const gate = readGate;
  readGate = null;
  gate?.release();
}

/**
 * One event-loop turn. Every promise-only double used with this fake settles in
 * it, so a case can assert what a run has not done yet without guessing a
 * duration and without starting a real timer.
 */
export function nextEventLoopTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setImmediate(() => {
    resolve(undefined);
  });
  return promise;
}
