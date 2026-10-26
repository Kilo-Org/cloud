import { z } from 'zod';
import type { SessionMetadata } from '../persistence/session-metadata.js';

export const TERMINAL_AUTHORIZATION_LIFETIME_MS = 60_000;
const RECHECK_MS = 30_000;
const RETRY_MS = 5_000;
const CHECK_TIMEOUT_MS = 5_000;
const STORAGE_KEY = 'terminal_authorization';
const leaseSchema = z.object({
  identity: z.string(),
  authorizedUntil: z.number().int().nonnegative(),
  checkAt: z.number().int().nonnegative(),
});

type TerminalAuthorizationDeps = {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;
  getMetadata: () => SessionMetadata | null | Promise<SessionMetadata | null>;
  checkAccess: (metadata: SessionMetadata) => Promise<'allowed' | 'denied' | 'unavailable'>;
  revokeTerminals: () => Promise<void>;
  schedule: () => Promise<void>;
};

function identity(metadata: SessionMetadata): string {
  return JSON.stringify([
    metadata.identity.userId,
    metadata.identity.sessionId,
    metadata.identity.orgId ?? null,
    metadata.auth.kiloSessionId ?? null,
  ]);
}

/** A failed check never extends access. Messages also enforce expiry if an alarm runs late. */
export function createTerminalAuthorization(deps: TerminalAuthorizationDeps) {
  let generation = 0;
  let checking: Promise<boolean> | undefined;
  let revoking: Promise<void> | undefined;

  async function read() {
    const parsed = leaseSchema.safeParse(await deps.storage.get<unknown>(STORAGE_KEY));
    const metadata = await deps.getMetadata();
    return parsed.success && metadata && parsed.data.identity === identity(metadata)
      ? parsed.data
      : null;
  }

  function revoke(): Promise<void> {
    if (revoking) return revoking;
    generation++;
    const pending = (async () => {
      try {
        await deps.storage.delete(STORAGE_KEY);
        await deps.revokeTerminals();
      } finally {
        await deps.schedule();
      }
    })().finally(() => {
      if (revoking === pending) revoking = undefined;
    });
    revoking = pending;
    return pending;
  }

  async function check(): Promise<boolean> {
    if (revoking) return false;
    const expectedGeneration = generation;
    const metadata = await deps.getMetadata();
    if (!metadata) return false;
    const expectedIdentity = identity(metadata);
    const startedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: 'allowed' | 'denied' | 'unavailable';
    try {
      result = await Promise.race([
        deps.checkAccess(metadata),
        new Promise<'unavailable'>(resolve => {
          timeout = setTimeout(() => resolve('unavailable'), CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch {
      result = 'unavailable';
    } finally {
      clearTimeout(timeout);
    }
    const currentMetadata = await deps.getMetadata();
    if (
      generation !== expectedGeneration ||
      !currentMetadata ||
      identity(currentMetadata) !== expectedIdentity
    )
      return false;
    if (result === 'allowed') {
      await deps.storage.put(STORAGE_KEY, {
        identity: expectedIdentity,
        authorizedUntil: startedAt + TERMINAL_AUTHORIZATION_LIFETIME_MS,
        checkAt: startedAt + RECHECK_MS,
      });
      if (generation !== expectedGeneration) {
        await deps.storage.delete(STORAGE_KEY);
        return false;
      }
      await deps.schedule();
      return generation === expectedGeneration;
    }
    const lease = await read();
    if (generation !== expectedGeneration) return false;
    if (result === 'unavailable' && lease && lease.authorizedUntil > Date.now()) {
      await deps.storage.put(STORAGE_KEY, {
        ...lease,
        checkAt: Math.min(lease.authorizedUntil, Date.now() + RETRY_MS),
      });
      if (generation !== expectedGeneration) {
        await deps.storage.delete(STORAGE_KEY);
        return false;
      }
      await deps.schedule();
      return generation === expectedGeneration && lease.authorizedUntil > Date.now();
    }
    await revoke();
    return false;
  }

  function recheck(): Promise<boolean> {
    if (checking) return checking;
    const pending = check().finally(() => {
      if (checking === pending) checking = undefined;
    });
    checking = pending;
    return pending;
  }

  async function ensure(): Promise<boolean> {
    if (revoking) return false;
    if (checking) return checking;
    const expectedGeneration = generation;
    const lease = await read();
    if (revoking || generation !== expectedGeneration) return false;
    if (checking) return checking;
    return lease && lease.authorizedUntil > Date.now() ? true : recheck();
  }

  async function maintain(): Promise<void> {
    const lease = await read();
    if (lease && lease.checkAt <= Date.now()) await recheck();
  }

  async function nextCheckAt(): Promise<number | null> {
    return (await read())?.checkAt ?? null;
  }

  return { ensure, maintain, nextCheckAt, revoke, revision: () => generation };
}
