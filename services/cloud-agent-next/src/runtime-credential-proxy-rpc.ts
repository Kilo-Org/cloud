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
  type RuntimeProxyGrant,
} from './runtime-credential-proxy.js';
import type { SessionMetadata } from './persistence/session-metadata.js';

type Storage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

type RuntimeFence = {
  generation: number;
  allocationId: string;
  wrapperRunId: string;
  wrapperConnectionId: string;
};

const RUNTIME_PROXY_LEASE_MS = 24 * 60 * 60_000;

function tokenExpiry(token: string): number | null {
  const decoded = jwt.decode(token);
  return typeof decoded === 'object' && decoded !== null && typeof decoded.exp === 'number'
    ? decoded.exp * 1000
    : null;
}

function context(metadata: SessionMetadata, fence: RuntimeFence) {
  const kiloSessionId = metadata.auth.kiloSessionId;
  if (!kiloSessionId) return null;
  return {
    sessionId: metadata.identity.sessionId,
    kiloSessionId,
    userId: metadata.identity.userId,
    ...(metadata.identity.orgId ? { orgId: metadata.identity.orgId } : {}),
    ...fence,
  };
}

/**
 * Shared private-DO grant lifecycle. The transport lease outlives individual
 * backing tokens so renewal remains transparent to Kilo, but proxy requests
 * can never lengthen the persisted lease.
 */
export async function issuePersistedRuntimeProxyGrant(input: {
  env: { NEXTAUTH_SECRET: unknown };
  storage: Storage;
  metadata: SessionMetadata | null;
  authorization: RuntimeAuthorization | null;
  fence: RuntimeFence | null;
  token: string | null;
  mode: RuntimeProxyGrant['mode'];
}): Promise<string | null> {
  const current = input.metadata && input.fence ? context(input.metadata, input.fence) : null;
  const tokenExpiresAt = input.token ? tokenExpiry(input.token) : null;
  if (
    !current ||
    !tokenExpiresAt ||
    tokenExpiresAt <= Date.now() ||
    input.authorization?.state !== 'active'
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
    parsedExisting.data.generation === current.generation &&
    parsedExisting.data.allocationId === current.allocationId &&
    parsedExisting.data.wrapperRunId === current.wrapperRunId &&
    parsedExisting.data.wrapperConnectionId === current.wrapperConnectionId &&
    parsedExisting.data.mode === input.mode &&
    parsedExisting.data.leaseExpiresAt > Date.now()
  ) {
    return issueRuntimeCredentialProxyHandle(
      input.env as never,
      parsedExisting.data,
      parsedExisting.data.issuedAt
    );
  }
  const issuedAt = Date.now();
  const grant = createRuntimeProxyGrant({
    authorizationId: input.authorization.id,
    ...current,
    mode: input.mode,
    leaseExpiresAt: issuedAt + RUNTIME_PROXY_LEASE_MS,
    state: 'active',
    issuedAt,
  });
  await input.storage.put(RUNTIME_PROXY_GRANT_KEY, grant);
  return issueRuntimeCredentialProxyHandle(input.env as never, grant, issuedAt);
}

export async function resolvePersistedRuntimeProxyCredential(input: {
  env: { NEXTAUTH_SECRET: unknown };
  storage: Storage;
  handle: string;
  metadata: () => Promise<SessionMetadata | null>;
  authorization: () => Promise<RuntimeAuthorization | null>;
  fence: () => Promise<RuntimeFence | null>;
  token: () => Promise<string | null>;
}): Promise<{ token: string; organizationId?: string } | null> {
  const claims = await verifyRuntimeCredentialProxyHandle(input.env as never, input.handle);
  if (!claims) return null;
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
      now: Date.now(),
    })
  )
    return null;
  const backingToken = await input.token();
  if (!backingToken) return null;
  const resolved = await resolveRuntimeProxyCredential({
    env: input.env as never,
    handle: input.handle,
    grant,
    authorization,
    context: current,
    token: backingToken,
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
      now: Date.now(),
    })
  ) {
    return null;
  }
  return {
    token: resolved.token,
    ...(latest.orgId ? { organizationId: latest.orgId } : {}),
  };
}
