import jwt from 'jsonwebtoken';
import { logRuntimeAuthorizationDiagnostic } from './runtime-authorization-diagnostics.js';
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
export const RUNTIME_AUTHORIZATION_RECOVERY_DIAGNOSTICS_KEY =
  'runtime_authorization_recovery_diagnostics';
const recoveryDiagnosticsSchema = runtimeAuthorizationRecoveryLockSchema.extend({
  startedAt: z.number().int().nonnegative(),
  lastWarningAt: z.number().int().nonnegative().optional(),
});
// Observation-driven diagnostics only; this is never a lock expiry deadline.
export const RUNTIME_AUTHORIZATION_RECOVERY_WARNING_MS = 5 * 60_000;

export function inspectRuntimeAuthorizationRecoveryLock(
  lock: z.infer<typeof runtimeAuthorizationRecoveryLockSchema>,
  diagnostics: unknown,
  now: number
) {
  const parsed = recoveryDiagnosticsSchema.safeParse(diagnostics);
  const current =
    parsed.success &&
    parsed.data.expectedOldId === lock.expectedOldId &&
    parsed.data.recoveryId === lock.recoveryId
      ? parsed.data
      : undefined;
  // For legacy locks the true start is unknown; persist the first observation.
  const startedAt = current?.startedAt ?? now;
  const warn =
    now - startedAt >= RUNTIME_AUTHORIZATION_RECOVERY_WARNING_MS &&
    (current?.lastWarningAt === undefined ||
      now - current.lastWarningAt >= RUNTIME_AUTHORIZATION_RECOVERY_WARNING_MS);
  return {
    diagnostics: {
      ...lock,
      startedAt,
      ...(current?.lastWarningAt !== undefined ? { lastWarningAt: current.lastWarningAt } : {}),
      ...(warn ? { lastWarningAt: now } : {}),
    },
    changed: !current || warn,
    warn,
  };
}

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
    if (input.metadata && hasModernRuntimeAuthorization(input.metadata)) {
      logRuntimeAuthorizationDiagnostic(
        input.metadata.identity.sessionId,
        'recovery_state',
        'stored_authorization_invalid'
      );
      return { state: 'revoked' };
    }
    return { state: 'legacy' };
  }
  if (authorization.data.state !== 'active') {
    logRuntimeAuthorizationDiagnostic(
      input.metadata?.identity.sessionId,
      'recovery_state',
      'stored_authorization_revoked'
    );
    return { state: 'revoked' };
  }
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
    if (hasModernRuntimeAuthorization(metadata)) {
      logRuntimeAuthorizationDiagnostic(
        metadata.identity.sessionId,
        'renewal',
        'stored_authorization_invalid'
      );
      throw new RuntimeAuthorizationRevokedError();
    }
    return metadata.auth.kilocodeToken ?? null;
  }
  if (authorization.data.state !== 'active') {
    logRuntimeAuthorizationDiagnostic(
      metadata.identity.sessionId,
      'renewal',
      'stored_authorization_revoked'
    );
    throw new RuntimeAuthorizationRevokedError();
  }
  const now = input.now ?? Date.now();
  const revokeIfCurrent = async () => {
    const current = RuntimeAuthorizationSchema.safeParse(await input.getAuthorization());
    if (
      current.success &&
      current.data.id === authorization.data.id &&
      current.data.state === 'active'
    ) {
      await input.putAuthorization({ ...current.data, state: 'revoked' });
      logRuntimeAuthorizationDiagnostic(
        metadata.identity.sessionId,
        'renewal',
        'revocation_persisted'
      );
    }
  };
  if (Date.parse(authorization.data.delegationExpiresAt) <= now) {
    logRuntimeAuthorizationDiagnostic(metadata.identity.sessionId, 'renewal', 'delegation_expired');
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
  let postRenewalStateChanged = false;
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
      postRenewalStateChanged = true;
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
    logRuntimeAuthorizationDiagnostic(
      metadata.identity.sessionId,
      'renewal',
      postRenewalStateChanged
        ? 'post_renewal_state_changed'
        : error instanceof RuntimeAuthorizationRevokedError
          ? 'renewal_revoked'
          : error instanceof RuntimeAuthorizationExpiredError
            ? 'delegation_expired'
            : 'renewal_failed'
    );
    if (error instanceof RuntimeAuthorizationRevokedError) await revokeIfCurrent();
    throw error;
  }
}
