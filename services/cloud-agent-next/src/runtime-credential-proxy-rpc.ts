import jwt from 'jsonwebtoken';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
  matchesRuntimeProxyGrant,
  resolveRuntimeProxyCredential,
  RUNTIME_PROXY_GRANT_KEY,
  runtimeProxyGrantSchema,
  verifyRuntimeCredentialProxyHandle,
  type RuntimeProxyFence,
  type RuntimeProxyGrant,
} from './runtime-credential-proxy.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import type { Env } from './types.js';

type Storage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

const RUNTIME_PROXY_LEASE_MS = 24 * 60 * 60_000;

function tokenExpiry(token: string): number | null {
  const decoded = jwt.decode(token);
  return typeof decoded === 'object' && decoded !== null && typeof decoded.exp === 'number'
    ? decoded.exp * 1000
    : null;
}

function context(metadata: SessionMetadata, fence: RuntimeProxyFence) {
  const kiloSessionId = metadata.auth.kiloSessionId;
  if (!kiloSessionId) return null;
  return {
    sessionId: metadata.identity.sessionId,
    kiloSessionId,
    userId: metadata.identity.userId,
    ...(metadata.identity.orgId ? { orgId: metadata.identity.orgId } : {}),
    fence,
  };
}

function sameFence(left: RuntimeProxyFence, right: RuntimeProxyFence): boolean {
  if (left.plane !== right.plane || left.allocationId !== right.allocationId) return false;
  return left.plane === 'legacy' && right.plane === 'legacy'
    ? left.generation === right.generation &&
        left.wrapperRunId === right.wrapperRunId &&
        left.wrapperConnectionId === right.wrapperConnectionId
    : left.plane === 'control' &&
        right.plane === 'control' &&
        left.providerInstanceId === right.providerInstanceId &&
        left.connectionId === right.connectionId &&
        left.wrapperInstanceId === right.wrapperInstanceId;
}

/**
 * Shared private-DO grant lifecycle. The transport lease outlives individual
 * backing tokens so renewal remains transparent to Kilo, but proxy requests
 * can never lengthen the persisted lease.
 */
export async function issuePersistedRuntimeProxyGrant(input: {
  env: Pick<Env, 'NEXTAUTH_SECRET'>;
  storage: Storage;
  metadata: SessionMetadata | null;
  authorization: RuntimeAuthorization | null;
  fence: RuntimeProxyFence | null;
  token: string | null;
  mode: RuntimeProxyGrant['mode'];
  now?: number;
}): Promise<string | null> {
  const now = input.now ?? Date.now();
  const current = input.metadata && input.fence ? context(input.metadata, input.fence) : null;
  const tokenExpiresAt = input.token ? tokenExpiry(input.token) : null;
  const delegationExpiresAt =
    input.authorization === null ? null : Date.parse(input.authorization.delegationExpiresAt);
  if (
    !current ||
    !tokenExpiresAt ||
    tokenExpiresAt <= now ||
    input.authorization?.state !== 'active' ||
    !delegationExpiresAt ||
    delegationExpiresAt <= now
  )
    return null;
  const existing = await input.storage.get<unknown>(RUNTIME_PROXY_GRANT_KEY);
  const parsedExisting = runtimeProxyGrantSchema.safeParse(existing);
  if (
    parsedExisting.success &&
    parsedExisting.data.issuedAt !== undefined &&
    parsedExisting.data.authorizationId === input.authorization.id &&
    parsedExisting.data.sessionId === current.sessionId &&
    parsedExisting.data.kiloSessionId === current.kiloSessionId &&
    parsedExisting.data.userId === current.userId &&
    parsedExisting.data.orgId === current.orgId &&
    parsedExisting.data.allocationId === current.fence.allocationId &&
    sameFence(parsedExisting.data, current.fence) &&
    parsedExisting.data.mode === input.mode &&
    parsedExisting.data.leaseExpiresAt > now &&
    parsedExisting.data.leaseExpiresAt <= delegationExpiresAt
  ) {
    return issueRuntimeCredentialProxyHandle(
      input.env,
      parsedExisting.data,
      parsedExisting.data.issuedAt
    );
  }
  const issuedAt = now;
  const { fence, ...identity } = current;
  const grant = createRuntimeProxyGrant({
    authorizationId: input.authorization.id,
    ...identity,
    ...fence,
    mode: input.mode,
    leaseExpiresAt: Math.min(issuedAt + RUNTIME_PROXY_LEASE_MS, delegationExpiresAt),
    state: 'active',
    issuedAt,
  });
  await input.storage.put(RUNTIME_PROXY_GRANT_KEY, grant);
  return issueRuntimeCredentialProxyHandle(input.env, grant, issuedAt);
}

export async function resolvePersistedRuntimeProxyCredential(input: {
  env: Pick<Env, 'NEXTAUTH_SECRET'>;
  storage: Storage;
  handle: string;
  metadata: () => Promise<SessionMetadata | null>;
  authorization: () => Promise<RuntimeAuthorization | null>;
  fence: () => Promise<RuntimeProxyFence | null>;
  token: () => Promise<string | null>;
  now?: number;
}): Promise<{
  token: string;
  organizationId?: string;
  runtimeAuthorization: { userId: string; authorizationId: string; resourceId: string };
} | null> {
  const now = input.now ?? Date.now();
  const claims = await verifyRuntimeCredentialProxyHandle(input.env, input.handle);
  if (!claims || !('sessionId' in claims)) return null;
  const [metadata, authorization, fence, grant] = await Promise.all([
    input.metadata(),
    input.authorization(),
    input.fence(),
    input.storage.get<unknown>(RUNTIME_PROXY_GRANT_KEY),
  ]);
  const current = metadata && fence ? context(metadata, fence) : null;
  if (!current || !authorization) return null;
  if (
    !matchesRuntimeProxyGrant(grant, claims, {
      ...current,
      authorizationId: authorization.id,
      now,
    })
  )
    return null;
  const backingToken = await input.token();
  if (!backingToken) return null;
  const resolved = await resolveRuntimeProxyCredential({
    env: input.env,
    handle: input.handle,
    grant,
    authorization,
    context: current,
    token: backingToken,
    now,
    renew: async () => (await input.token()) ?? '',
  });
  if (!resolved?.token) return null;

  // Renewal awaits external I/O. Re-read all durable fences before exposing it.
  const [latestMetadata, latestAuthorization, latestFence, latestGrant] = await Promise.all([
    input.metadata(),
    input.authorization(),
    input.fence(),
    input.storage.get<unknown>(RUNTIME_PROXY_GRANT_KEY),
  ]);
  const latest = latestMetadata && latestFence ? context(latestMetadata, latestFence) : null;
  if (
    !latest ||
    !latestAuthorization ||
    !matchesRuntimeProxyGrant(latestGrant, claims, {
      ...latest,
      authorizationId: latestAuthorization.id,
      now,
    })
  ) {
    return null;
  }
  return {
    token: resolved.token,
    ...(latest.orgId ? { organizationId: latest.orgId } : {}),
    runtimeAuthorization: {
      userId: latestAuthorization.userId,
      authorizationId: latestAuthorization.id,
      resourceId: latestAuthorization.resourceId,
    },
  };
}
