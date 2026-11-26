import {
  signerKeysHttpStatus,
  UTS_SIGNER_COUNT,
  UTS_SIGNER_KEYS_HOLD_MS,
  type SignerKeysAnswer,
  type SignerKeysEntry,
  type UtsEnvironment,
  type UtsPublicJwk,
} from '@kilocode/uts-contracts';
import { DEFAULT_DO_RETRY_CONFIG, withDORetry } from '@kilocode/worker-utils';
import { z } from 'zod';
import type { PublicKeysResult } from './dos/UtsSignerDO';
import { getSignerStub } from './dos/stubs';
import { FEED_DEPLOYMENTS, type Env, type UtsConfig } from './env';
import { jsonResponse } from './responses';

/**
 * An isolate answers from its copy of the last combined answer for this long after that read
 * started. The signer objects therefore see at most one read per mint isolate per 2 seconds,
 * however many feed isolates ask (design 3).
 */
export const SIGNER_KEYS_COPY_MS = 2 * 1000;

/**
 * Every signer call of one read, retries included, ends by this deadline, so a read settles
 * within it even when an object hangs. It is shorter than the feed Worker's 10-second read guard,
 * so the feed Worker still receives the answer built from the held keys.
 */
export const SIGNER_READ_DEADLINE_MS = 5 * 1000;

const WAIT_STEP_MS = 20;

export type HeldSignerKeys = { keys: UtsPublicJwk[]; readAt: number };

export type SignerAnswers = ReadonlyArray<PromiseSettledResult<PublicKeysResult>>;

/** Reads the 16 signer objects; `startedAt` is the read's start, which its deadline counts from. */
export type ReadSigners = (startedAt: number) => Promise<SignerAnswers>;

/**
 * Isolate state, plain data only: a request never awaits a promise another request started
 * (design 7); it polls `read` instead. One state per environment, as in the feed Worker.
 */
type SignerKeysIsolate = {
  environment: UtsEnvironment;
  /** Each signer's last good keys, which stand in for its failed calls for 24 hours. */
  held: ReadonlyArray<HeldSignerKeys | null>;
  copy: { answer: SignerKeysAnswer; readAt: number } | null;
  read: { status: 'idle' } | { status: 'reading'; startedAt: number };
};

let isolate: SignerKeysIsolate | null = null;

const CallerPropsSchema = z.strictObject({ caller: z.string().min(1) });

/** The caller a service binding's `props` name; null for a request that came from the internet. */
function callerOf(props: unknown): string | null {
  const parsed = CallerPropsSchema.safeParse(props);
  return parsed.success ? parsed.data.caller : null;
}

/** The entry of a signer without an answer: its held keys while under 24 hours old. */
function heldEntry(
  signer: number,
  held: HeldSignerKeys | null,
  now: number,
  failure: 'misconfigured' | 'unavailable'
): SignerKeysEntry {
  return held !== null && now - held.readAt < UTS_SIGNER_KEYS_HOLD_MS
    ? { signer, status: 'ok', keys: held.keys, readAt: held.readAt }
    : { signer, status: failure };
}

/**
 * Combines the 16 answers of the read that started at `readAt`, in signer order, with the keys
 * held from earlier reads. A signer that answered gives its keys at `readAt`, and they become its
 * held keys unless newer ones are held already. A signer whose call failed after its retries, or
 * whose object refused to load, gives its held keys while they are under 24 hours old, and its
 * failure otherwise. Each failure is logged; a refused object stays refused until a deploy fixes
 * it, so it is `misconfigured`, not `unavailable`.
 */
export function combineSignerKeys(
  answers: SignerAnswers,
  held: ReadonlyArray<HeldSignerKeys | null>,
  readAt: number,
  now: number
): { answer: SignerKeysAnswer; held: Array<HeldSignerKeys | null> } {
  const nextHeld: Array<HeldSignerKeys | null> = [];
  const signers: SignerKeysEntry[] = [];
  for (const [signer, answer] of answers.entries()) {
    const previous = held[signer] ?? null;
    let failure: { status: 'misconfigured' | 'unavailable'; event: string; error: string };
    if (answer.status === 'rejected') {
      failure = {
        status: 'unavailable',
        event: 'uts.signer_keys.signer_failed',
        error: String(answer.reason),
      };
    } else if (answer.value.status === 'misconfigured') {
      failure = {
        status: 'misconfigured',
        event: 'uts.signer_keys.signer_misconfigured',
        error: answer.value.reason,
      };
    } else {
      const best =
        previous !== null && previous.readAt > readAt
          ? previous
          : { keys: answer.value.keys, readAt };
      nextHeld.push(best);
      signers.push({ signer, status: 'ok', keys: best.keys, readAt: best.readAt });
      continue;
    }
    const entry = heldEntry(signer, previous, now, failure.status);
    console.error(
      JSON.stringify({
        event: failure.event,
        signer,
        error: failure.error,
        heldReadAt: entry.status === 'ok' ? entry.readAt : null,
      })
    );
    nextHeld.push(previous);
    signers.push(entry);
  }
  return { answer: { signers }, held: nextHeld };
}

function isolateFor(environment: UtsEnvironment): SignerKeysIsolate {
  if (isolate === null || isolate.environment !== environment) {
    isolate = {
      environment,
      held: Array.from({ length: UTS_SIGNER_COUNT }, () => null),
      copy: null,
      read: { status: 'idle' },
    };
  }
  return isolate;
}

/**
 * Waits, without sharing its promise, for the read that started at `startedAt`. That read ends by
 * its deadline; a request that still finds no answer from it gets the held keys alone.
 */
async function waitForRead(state: SignerKeysIsolate, startedAt: number): Promise<SignerKeysAnswer> {
  const deadline = startedAt + SIGNER_READ_DEADLINE_MS;
  while (state.read.status === 'reading' && Date.now() < deadline) {
    await scheduler.wait(WAIT_STEP_MS);
  }
  if (state.copy !== null && state.copy.readAt >= startedAt) return state.copy.answer;
  const now = Date.now();
  return {
    signers: state.held.map((held, signer) => heldEntry(signer, held, now, 'unavailable')),
  };
}

/**
 * The answer for one request. A copy under 2 seconds old answers at once. Otherwise the request
 * waits for the read in flight, or starts the next read itself; a read that finishes late never
 * replaces a newer copy or newer held keys.
 */
export async function signerKeysAnswer(
  environment: UtsEnvironment,
  readSigners: ReadSigners
): Promise<SignerKeysAnswer> {
  const state = isolateFor(environment);
  const now = Date.now();
  if (state.copy !== null && now - state.copy.readAt < SIGNER_KEYS_COPY_MS) {
    return state.copy.answer;
  }
  if (state.read.status === 'reading' && now - state.read.startedAt < SIGNER_READ_DEADLINE_MS) {
    return await waitForRead(state, state.read.startedAt);
  }
  state.read = { status: 'reading', startedAt: now };
  const answers = await readSigners(now);
  const combined = combineSignerKeys(answers, state.held, now, Date.now());
  state.held = combined.held;
  if (state.copy === null || state.copy.readAt < now) {
    state.copy = { answer: combined.answer, readAt: now };
  }
  if (state.read.status === 'reading' && state.read.startedAt === now) {
    state.read = { status: 'idle' };
  }
  return combined.answer;
}

/** Every signer's published keys, read from the 16 signer objects in parallel. */
async function readSignerObjects(
  env: Env,
  config: UtsConfig,
  startedAt: number
): Promise<SignerAnswers> {
  const retry = {
    ...DEFAULT_DO_RETRY_CONFIG,
    scope: { deadlineAt: startedAt + SIGNER_READ_DEADLINE_MS },
  };
  return await Promise.allSettled(
    Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) =>
      withDORetry(
        () => getSignerStub(env, config, signer),
        async (stub): Promise<PublicKeysResult> => await stub.publicKeys(),
        'uts.signer.publicKeys',
        retry
      )
    )
  );
}

/**
 * The internal signer-keys route (`UTS_SIGNER_KEYS_PATH`). It runs in the mint Worker's fetch
 * handler, which placement runs next to the identity store's primary, so the 16 signer calls
 * start next to the signer objects in western Europe. It answers only the feed Worker of its own
 * environment: a service binding carries `props.caller`, and only a deploy in the account can set
 * props, so the check is deploy-level trust, as for the STS broker (design 6.4). A request
 * without that caller, from the internet or from another binding, gets the same 404 as an unknown
 * path. `test/repo` keeps every other config from binding the mint Worker.
 */
export async function signerKeysResponse(
  request: Request,
  env: Env,
  config: UtsConfig,
  props: unknown
): Promise<Response> {
  const caller = callerOf(props);
  if (caller !== FEED_DEPLOYMENTS[config.environment]) {
    if (caller !== null) {
      console.warn(JSON.stringify({ event: 'uts.signer_keys.refused', caller }));
    }
    return jsonResponse({ error: 'not_found' }, 404);
  }
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  }
  const answer = await signerKeysAnswer(config.environment, startedAt =>
    readSignerObjects(env, config, startedAt)
  );
  return jsonResponse(answer, signerKeysHttpStatus(answer));
}

/** Test seam: drops this isolate's copy, held keys and read state, as a new isolate starts. */
export function resetSignerKeysIsolate(): void {
  isolate = null;
}
