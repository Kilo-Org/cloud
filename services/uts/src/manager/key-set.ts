import { withDORetry } from '@kilocode/worker-utils';
import { getManagerAuthStub } from '../dos/stubs';
import type {
  ManagerJwks,
  ManagerJwksResult,
  ManagerLoginJwtResult,
} from '../dos/UtsManagerAuthDO';
import type { Env, UtsConfig } from '../env';
import { jsonResponse } from '../responses';
import { ManagerClient } from './client';
import { managerConfig } from './config';

/** An isolate keeps a non-empty key set this long; the manager reads it once per login. */
const JWKS_CACHE_MS = 60_000;

/**
 * An isolate keeps an empty set or a failed read this long, so a client that polls the public route
 * reaches the single key object at most once per window.
 */
const MISS_CACHE_MS = 5_000;

/** Seconds a manager waits before it asks again while the key object does not answer. */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/** The isolate's last key-set read: the keys, an empty set before the first login, or a failure. */
type HeldKeySet = { environment: string; expiresAt: number } & (
  | { kind: 'keys'; jwks: ManagerJwks }
  | { kind: 'empty' }
  | { kind: 'failed' }
);

let held: HeldKeySet | null = null;

/** Counts the login JWTs this isolate signed; a key-set read that overlaps one is not kept. */
let signedLogins = 0;

/** Drops the isolate's key-set read; tests only. */
export function resetManagerKeySet(): void {
  held = null;
}

/** Copies a workerd RPC result into plain data, then releases the result's disposer. */
async function plain<Result extends object>(
  call: () => Promise<Result & Partial<Disposable>>,
  copy: (result: Result) => Result
): Promise<Result> {
  const result = await call();
  try {
    return copy(result);
  } finally {
    result[Symbol.dispose]?.();
  }
}

function unavailable(): Response {
  return jsonResponse({ error: 'temporarily_unavailable' }, 503, {
    'Retry-After': String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/** The isolate's answer for `held`. */
function heldResponse(entry: HeldKeySet): Response {
  switch (entry.kind) {
    case 'keys':
      return jsonResponse(entry.jwks, 200, { 'Cache-Control': 'public, max-age=60' });
    case 'empty':
      return jsonResponse({ keys: [] }, 200);
    case 'failed':
      return unavailable();
  }
}

/**
 * `GET /manager-auth/.well-known/jwks.json`: the public half of the manager login key (design
 * 4.2). Before the first login creates the key the set is empty; a key object that fails or
 * refuses its name answers 503, never 500. The isolate keeps a non-empty set for a minute and an
 * empty set or a failure for a few seconds; a login JWT signed in this isolate drops the empty set,
 * so the key that login created is served at once.
 */
export async function managerKeySet(env: Env, config: UtsConfig): Promise<Response> {
  if (held !== null && held.environment === config.environment && held.expiresAt > Date.now()) {
    return heldResponse(held);
  }
  const loginsBefore = signedLogins;
  let result: ManagerJwksResult | { status: 'failed' };
  try {
    result = await withDORetry(
      () => getManagerAuthStub(env, config),
      stub =>
        plain<ManagerJwksResult>(
          () => stub.jwks(),
          answer =>
            answer.status === 'ok'
              ? { status: 'ok', jwks: { keys: answer.jwks.keys.map(key => ({ ...key })) } }
              : { status: 'misconfigured', reason: answer.reason }
        ),
      'uts.managerAuth.jwks'
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'uts.manager_auth.jwks_failed',
        error: error instanceof Error ? error.name : 'unknown',
        message: 'manager key object did not answer',
      })
    );
    result = { status: 'failed' };
  }
  if (result.status === 'misconfigured') {
    console.error(
      JSON.stringify({ event: 'uts.manager_auth.misconfigured', reason: result.reason })
    );
  }
  const environment = config.environment;
  const settledAt = Date.now();
  const entry: HeldKeySet =
    result.status !== 'ok'
      ? { environment, expiresAt: settledAt + MISS_CACHE_MS, kind: 'failed' }
      : result.jwks.keys.length === 0
        ? { environment, expiresAt: settledAt + MISS_CACHE_MS, kind: 'empty' }
        : { environment, expiresAt: settledAt + JWKS_CACHE_MS, kind: 'keys', jwks: result.jwks };
  // A login signed while this read was in flight may have created the key after the object
  // answered, so an older answer must not replace what that login cleared.
  if (signedLogins === loginsBefore) held = entry;
  return heldResponse(entry);
}

/**
 * One login JWT from the key object, which creates the key on its first call. A signed JWT drops
 * an empty set or a failure this isolate holds, so the manager's key-set read for this login asks
 * the object again and sees the new key.
 */
export async function signManagerLoginJwt(
  env: Env,
  config: UtsConfig
): Promise<ManagerLoginJwtResult> {
  const signed = await withDORetry(
    () => getManagerAuthStub(env, config),
    stub =>
      plain<ManagerLoginJwtResult>(
        () => stub.signLoginJwt(),
        answer => ({ ...answer })
      ),
    'uts.managerAuth.signLoginJwt'
  );
  if (signed.status === 'signed') {
    signedLogins += 1;
    if (held?.kind !== 'keys') held = null;
  }
  return signed;
}

/** The rotation job's manager client, or null in a development run without a stand-in manager. */
export function rotationManager(env: Env, config: UtsConfig): ManagerClient | null {
  const manager = managerConfig(config);
  if (manager === null) return null;
  return new ManagerClient(manager, () => signManagerLoginJwt(env, config));
}
