import jwt from 'jsonwebtoken';
import { RuntimeAuthorizationRevokedError } from '@kilocode/worker-utils/runtime-authorization';
import {
  RuntimeAuthorizationSchema,
  type RuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization-contract';
import { serializeSessionMetadata, type SessionMetadata } from '../persistence/session-metadata.js';

export const RUNTIME_AUTHORIZATION_KEY = 'runtime_authorization';
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
}): Promise<'legacy' | 'active' | 'revoked'> {
  const authorization = RuntimeAuthorizationSchema.safeParse(await input.getAuthorization());
  if (authorization.success) return authorization.data.state;
  return input.metadata && hasModernRuntimeAuthorization(input.metadata) ? 'revoked' : 'legacy';
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
  const token = metadata.auth.kilocodeToken;
  const decoded = token ? jwt.decode(token) : null;
  if (
    typeof decoded === 'object' &&
    decoded !== null &&
    typeof decoded.exp === 'number' &&
    decoded.exp * 1000 > (input.now ?? Date.now()) + RUNTIME_TOKEN_RENEWAL_WINDOW_MS &&
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
    if (error instanceof RuntimeAuthorizationRevokedError) {
      const current = RuntimeAuthorizationSchema.safeParse(await input.getAuthorization());
      if (current.success && current.data.id === authorization.data.id) {
        await input.putAuthorization({ ...current.data, state: 'revoked' });
      }
    }
    throw error;
  }
}
