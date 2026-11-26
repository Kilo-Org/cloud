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

/** Seconds a manager waits before it asks again while the key object does not answer. */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

let jwksCache: { environment: string; jwks: ManagerJwks; expiresAt: number } | null = null;

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

/**
 * `GET /manager-auth/.well-known/jwks.json`: the public half of the manager login key (design
 * 4.2). Before the first login creates the key the set is empty; a key object that fails or
 * refuses its name answers 503, never 500. Only a non-empty set is cached, so the key a first
 * login creates is served at once.
 */
export async function managerKeySet(env: Env, config: UtsConfig): Promise<Response> {
  const cached = jwksCache;
  if (
    cached !== null &&
    cached.environment === config.environment &&
    cached.expiresAt > Date.now()
  ) {
    return jsonResponse(cached.jwks, 200, { 'Cache-Control': 'public, max-age=60' });
  }
  let result: ManagerJwksResult;
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
    console.error(JSON.stringify({ event: 'uts.manager_auth.jwks_failed', error: String(error) }));
    return unavailable();
  }
  if (result.status === 'misconfigured') {
    console.error(
      JSON.stringify({ event: 'uts.manager_auth.misconfigured', reason: result.reason })
    );
    return unavailable();
  }
  if (result.jwks.keys.length === 0) return jsonResponse(result.jwks, 200);
  jwksCache = {
    environment: config.environment,
    jwks: result.jwks,
    expiresAt: Date.now() + JWKS_CACHE_MS,
  };
  return jsonResponse(result.jwks, 200, { 'Cache-Control': 'public, max-age=60' });
}

/** One login JWT from the key object, which creates the key on its first call. */
export async function signManagerLoginJwt(
  env: Env,
  config: UtsConfig
): Promise<ManagerLoginJwtResult> {
  return await withDORetry(
    () => getManagerAuthStub(env, config),
    stub =>
      plain<ManagerLoginJwtResult>(
        () => stub.signLoginJwt(),
        answer => ({ ...answer })
      ),
    'uts.managerAuth.signLoginJwt'
  );
}

/** The rotation job's manager client, or null in a development run without a stand-in manager. */
export function rotationManager(env: Env, config: UtsConfig): ManagerClient | null {
  const manager = managerConfig(config);
  if (manager === null) return null;
  return new ManagerClient(manager, () => signManagerLoginJwt(env, config));
}
