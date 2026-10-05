import jwt from 'jsonwebtoken';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
  matchesRuntimeProxyGrant,
  resolveRuntimeProxyCredential,
  RUNTIME_PROXY_GRANT_KEY,
  runtimeProxyGrantSchema,
  sameRuntimeProxyControlBinding,
  sameRuntimeProxyPhysicalBinding,
  verifyRuntimeCredentialProxyHandle,
  type RuntimeProxyFence,
  type RuntimeProxyGrant,
} from './runtime-credential-proxy.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import {
  logRuntimeProxyRequestFailed,
  type RuntimeProxyRejectionStage,
} from './runtime-credential-proxy-diagnostics.js';
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

function samePersistedGrantFence(grant: RuntimeProxyGrant, fence: RuntimeProxyFence): boolean {
  if (fence.plane === 'legacy') return sameRuntimeProxyPhysicalBinding(grant, fence);
  return grant.plane === 'control' && sameRuntimeProxyControlBinding(grant, fence);
}

function upgradeLegacyGrantToV3(
  grant: RuntimeProxyGrant,
  instanceGeneration: number
): RuntimeProxyGrant {
  return runtimeProxyGrantSchema.parse({
    version: 3,
    plane: 'legacy',
    grantId: grant.grantId,
    authorizationId: grant.authorizationId,
    sessionId: grant.sessionId,
    kiloSessionId: grant.kiloSessionId,
    userId: grant.userId,
    ...(grant.orgId === undefined ? {} : { orgId: grant.orgId }),
    nonce: grant.nonce,
    mode: grant.mode,
    allocationId: grant.allocationId,
    issuedAt: grant.issuedAt,
    leaseExpiresAt: grant.leaseExpiresAt,
    state: 'active',
    instanceGeneration,
  });
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
    parsedExisting.data.mode === input.mode &&
    parsedExisting.data.leaseExpiresAt > now &&
    parsedExisting.data.leaseExpiresAt <= delegationExpiresAt &&
    samePersistedGrantFence(parsedExisting.data, current.fence)
  ) {
    const stored = parsedExisting.data;
    const upgraded =
      stored.plane === 'legacy' && current.fence.plane === 'legacy' && stored.version !== 3
        ? upgradeLegacyGrantToV3(stored, current.fence.instanceGeneration)
        : stored;
    const refreshed: RuntimeProxyGrant =
      upgraded.plane === 'control' &&
      current.fence.plane === 'control' &&
      upgraded.connectionId !== current.fence.connectionId
        ? { ...upgraded, connectionId: current.fence.connectionId }
        : upgraded;
    if (refreshed !== stored) await input.storage.put(RUNTIME_PROXY_GRANT_KEY, refreshed);
    return issueRuntimeCredentialProxyHandle(input.env, refreshed, stored.issuedAt);
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
  if (!claims || !('sessionId' in claims)) {
    logRuntimeProxyRequestFailed({ upstreamAttempted: false, rejectionStage: 'handle' });
    return null;
  }
  const [metadata, authorization, fence, grant] = await Promise.all([
    input.metadata(),
    input.authorization(),
    input.fence(),
    input.storage.get<unknown>(RUNTIME_PROXY_GRANT_KEY),
  ]);
  const reject = (
    stage: RuntimeProxyRejectionStage,
    source: { metadata: SessionMetadata | null; fence: RuntimeProxyFence | null }
  ): null => {
    logRuntimeProxyRequestFailed({
      upstreamAttempted: false,
      rejectionStage: stage,
      sessionId: source.metadata?.identity.sessionId || claims.sessionId,
      kiloSessionId: source.metadata?.auth.kiloSessionId || claims.kiloSessionId,
      allocationId: source.fence?.allocationId ?? null,
      ...(source.fence?.plane === 'control'
        ? {
            wrapperInstanceId: source.fence.wrapperInstanceId,
            connectionId: source.fence.connectionId,
          }
        : {}),
    });
    return null;
  };
  const current = metadata && fence ? context(metadata, fence) : null;
  if (!current || !authorization) {
    if (!current) {
      const stage: RuntimeProxyRejectionStage = !metadata?.auth.kiloSessionId
        ? 'context'
        : !fence
          ? 'fence'
          : 'context';
      return reject(stage, { metadata, fence });
    }
    return reject('authorization', { metadata, fence });
  }
  if (
    !matchesRuntimeProxyGrant(grant, claims, {
      ...current,
      authorizationId: authorization.id,
      now,
    })
  )
    return reject('grant', { metadata, fence });
  const backingToken = await input.token();
  if (!backingToken) return reject('token', { metadata, fence });
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
  if (!resolved?.token) return reject('resolve', { metadata, fence });

  // Renewal awaits external I/O. Re-read all durable fences before exposing it.
  const [latestMetadata, latestAuthorization, latestFence, latestGrant] = await Promise.all([
    input.metadata(),
    input.authorization(),
    input.fence(),
    input.storage.get<unknown>(RUNTIME_PROXY_GRANT_KEY),
  ]);
  const latest = latestMetadata && latestFence ? context(latestMetadata, latestFence) : null;
  const latestNow = Date.now();
  if (
    !latest ||
    !latestAuthorization ||
    latestAuthorization.state !== 'active' ||
    Date.parse(latestAuthorization.delegationExpiresAt) <= latestNow ||
    !matchesRuntimeProxyGrant(latestGrant, claims, {
      ...latest,
      authorizationId: latestAuthorization.id,
      now: latestNow,
    })
  ) {
    const stage: RuntimeProxyRejectionStage = !latestMetadata?.auth.kiloSessionId
      ? 'context'
      : !latestFence
        ? 'fence'
        : !latest
          ? 'context'
          : !latestAuthorization ||
              latestAuthorization.state !== 'active' ||
              Date.parse(latestAuthorization.delegationExpiresAt) <= latestNow
            ? 'authorization'
            : 'grant';
    return reject(stage, { metadata: latestMetadata, fence: latestFence });
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
