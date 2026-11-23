import { z } from 'zod';
import { isSafeSandboxId } from '../shared/control-plane-credential.js';
import { hashSandboxCredential } from '../sandbox-control/credential.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';
import { createExpiringCache } from './expiring-cache.js';

export const sandboxEgressAdmissionSchema = z
  .object({ oidcToken: z.string().min(1).max(8192) })
  .strict();

export type SandboxEgressAdmission = z.infer<typeof sandboxEgressAdmissionSchema>;

/** The egress policy of a restricted sandbox, as the egress proxy route applies it. */
export type SandboxEgressAdmissionPolicy = {
  allowlist: string[];
  audit?: { allocationRef: string };
};

export type SandboxEgressAdmissionResult =
  /** No egress allowlist: the route keeps its managed SCM forwarding, which checks each request. */
  | { ok: true; policy: null }
  /** A verified sandbox identity; `expiresAt` is the identity expiry in milliseconds. */
  | { ok: true; policy: SandboxEgressAdmissionPolicy; expiresAt: number }
  | { ok: false; status: 401 | 403 | 503; code: string; retryAfter?: number };

const ISOLATE_CACHE_ENTRIES = 256;
const ISOLATE_CACHE_MAX_AGE_MS = 30_000;

/**
 * A Worker-isolate cache in front of the admission RPC, keyed by the sandbox id
 * and the token hash. It keeps only admitted results, for at most 30 seconds
 * and never past the verified identity expiry. So a stopped allocation can pass
 * for at most that time; the upstream set is still the allowlist.
 */
export function createEgressAdmissionCache(
  options: { maxEntries?: number; now?: () => number } = {}
) {
  const cache = createExpiringCache<Extract<SandboxEgressAdmissionResult, { ok: true }>>(
    options.maxEntries ?? ISOLATE_CACHE_ENTRIES
  );
  const now = options.now ?? Date.now;
  return async function admit(
    sandboxId: string,
    oidcToken: string,
    load: () => Promise<SandboxEgressAdmissionResult>
  ): Promise<SandboxEgressAdmissionResult> {
    const key = `${sandboxId}\n${await hashSandboxCredential(oidcToken)}`;
    const cached = cache.get(key, now());
    if (cached !== undefined) return cached;
    const result = await load();
    if (result.ok) {
      const maxAge = now() + ISOLATE_CACHE_MAX_AGE_MS;
      cache.set(key, result, result.policy === null ? maxAge : Math.min(maxAge, result.expiresAt));
    }
    return result;
  };
}

export function admitSandboxEgressAtLocator(
  env: Pick<Env, 'SANDBOX_CONTROL'>,
  logicalSandboxId: string,
  input: SandboxEgressAdmission
): Promise<SandboxEgressAdmissionResult> {
  if (!isSafeSandboxId(logicalSandboxId))
    return Promise.resolve({ ok: false, status: 403, code: 'allocation_unavailable' });
  return withDORetry(
    () => env.SANDBOX_CONTROL.getByName(logicalSandboxId),
    async stub => await stub.admitEgressForward(input),
    'admitEgressForward'
  );
}
