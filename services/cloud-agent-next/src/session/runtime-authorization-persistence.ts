import jwt from 'jsonwebtoken';
import {
  RuntimeAuthorizationExpiredError,
  RuntimeAuthorizationRevokedError,
} from '@kilocode/worker-utils/runtime-authorization';
import {
  RuntimeAuthorizationSchema,
  type RuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization-contract';
import { serializeSessionMetadata, type SessionMetadata } from '../persistence/session-metadata.js';
import { z } from 'zod';

export const RUNTIME_AUTHORIZATION_KEY = 'runtime_authorization';
export const RUNTIME_AUTHORIZATION_RECOVERY_KEY = 'runtime_authorization_recovery';
export const runtimeAuthorizationRecoveryLockSchema = z
  .object({ expectedOldId: z.string().uuid(), recoveryId: z.string().uuid() })
  .strict();
const RUNTIME_TOKEN_RENEWAL_WINDOW_MS = 5 * 60_000;

function runtimeAuthorizationId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('id' in value)) return null;
  return typeof value.id === 'string' ? value.id : null;
}

export function hasModernRuntimeAuthorization(metadata: SessionMetadata): boolean {
  const token = metadata.auth.kilocodeToken;
  if (!token) return false;
  const decoded = jwt.decode(token);
  return (
    typeof decoded === 'object' &&
    decoded !== null &&
    'runtimeAuthorization' in decoded &&
    typeof decoded.runtimeAuthorization === 'object' &&
    decoded.runtimeAuthorization !== null
  );
}

export async function getRuntimeAuthorizationStatus(input: {
  metadata: SessionMetadata | null;
  getAuthorization: () => Promise<unknown>;
  now?: number;
}): Promise<'legacy' | 'active' | 'revoked'> {
  const authorization = RuntimeAuthorizationSchema.safeParse(await input.getAuthorization());
  if (authorization.success) {
    return authorization.data.state === 'active' &&
      Date.parse(authorization.data.delegationExpiresAt) <= (input.now ?? Date.now())
      ? 'revoked'
      : authorization.data.state;
  }
  return input.metadata && hasModernRuntimeAuthorization(input.metadata) ? 'revoked' : 'legacy';
}

export type RuntimeAuthorizationRecoveryState = {
  state: 'legacy' | 'revoked' | 'active' | 'expired';
  id?: string;
};

export async function getRuntimeAuthorizationRecoveryState(input: {
  metadata: SessionMetadata | null;
  getAuthorization: () => Promise<unknown>;
  now?: number;
}): Promise<RuntimeAuthorizationRecoveryState> {
  const authorization = RuntimeAuthorizationSchema.safeParse(await input.getAuthorization());
  if (!authorization.success) {
    return input.metadata && hasModernRuntimeAuthorization(input.metadata)
      ? { state: 'revoked' }
      : { state: 'legacy' };
  }
  if (authorization.data.state !== 'active') return { state: 'revoked' };
  return Date.parse(authorization.data.delegationExpiresAt) <= (input.now ?? Date.now())
    ? { state: 'expired', id: authorization.data.id }
    : { state: 'active', id: authorization.data.id };
}

export async function renewStoredRuntimeAuthorization(input: {
  metadata: SessionMetadata | null;
  getAuthorization: () => Promise<unknown>;
  putAuthorization: (authorization: RuntimeAuthorization) => Promise<void>;
  getMetadata: () => Promise<SessionMetadata | null>;
  putMetadata: (metadata: SessionMetadata) => Promise<void>;
  renew: (authorization: RuntimeAuthorization) => Promise<{ token: string }>;
  now?: number;
}): Promise<string | null> {
  const metadata = input.metadata;
  if (!metadata) return null;
  const authorization = RuntimeAuthorizationSchema.safeParse(await input.getAuthorization());
  if (!authorization.success) {
    if (hasModernRuntimeAuthorization(metadata)) throw new RuntimeAuthorizationRevokedError();
    return metadata.auth.kilocodeToken ?? null;
  }
  if (authorization.data.state !== 'active') throw new RuntimeAuthorizationRevokedError();
  const now = input.now ?? Date.now();
  const revokeIfCurrent = async () => {
    const current = RuntimeAuthorizationSchema.safeParse(await input.getAuthorization());
    if (
      current.success &&
      current.data.id === authorization.data.id &&
      current.data.state === 'active'
    ) {
      await input.putAuthorization({ ...current.data, state: 'revoked' });
    }
  };
  if (Date.parse(authorization.data.delegationExpiresAt) <= now) {
    throw new RuntimeAuthorizationExpiredError();
  }
  const token = metadata.auth.kilocodeToken;
  const decoded = token ? jwt.decode(token) : null;
  if (
    typeof decoded === 'object' &&
    decoded !== null &&
    typeof decoded.exp === 'number' &&
    decoded.exp * 1000 > now + RUNTIME_TOKEN_RENEWAL_WINDOW_MS &&
    decoded.exp * 1000 <= Date.parse(authorization.data.delegationExpiresAt) &&
    runtimeAuthorizationId(decoded.runtimeAuthorization) === authorization.data.id
  ) {
    return token ?? null;
  }
  try {
    const renewed = await input.renew(authorization.data);
    const currentAuthorization = RuntimeAuthorizationSchema.safeParse(
      await input.getAuthorization()
    );
    const currentMetadata = await input.getMetadata();
    if (
      !currentAuthorization.success ||
      currentAuthorization.data.id !== authorization.data.id ||
      currentAuthorization.data.state !== 'active' ||
      !currentMetadata ||
      currentMetadata.identity.sessionId !== metadata.identity.sessionId ||
      currentMetadata.identity.userId !== metadata.identity.userId ||
      currentMetadata.identity.orgId !== metadata.identity.orgId
    ) {
      throw new RuntimeAuthorizationRevokedError();
    }
    await input.putMetadata(
      serializeSessionMetadata({
        ...currentMetadata,
        auth: { ...currentMetadata.auth, kilocodeToken: renewed.token },
      })
    );
    return renewed.token;
  } catch (error) {
    if (error instanceof RuntimeAuthorizationRevokedError) await revokeIfCurrent();
    throw error;
  }
}
