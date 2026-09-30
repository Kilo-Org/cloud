import { unsealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import {
  RuntimeAuthorizationSchema,
  type RuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization-contract';
import { resolveSecret, type SecretBinding } from '../auth.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import {
  runtimeAuthorizationRecoveryDenied,
  type RecoveryDenialReason,
} from './runtime-authorization-diagnostics.js';

export type RuntimeAuthorizationIdentity = {
  sessionId: string;
  userId: string;
  orgId?: string;
};

/**
 * Failure reasons reuse the recovery-diagnostics vocabulary so each caller can
 * map one reason onto its own denial, boolean, or error-message shape.
 */
export type RuntimeAuthorizationUnsealFailure =
  | 'missing_secret'
  | 'invalid_seal'
  | 'fresh_authorization_inactive';

export type UnsealedRuntimeAuthorization =
  | { status: 'active'; authorization: RuntimeAuthorization }
  | { status: RuntimeAuthorizationUnsealFailure };

export async function unsealActiveRuntimeAuthorization(input: {
  secretBinding: SecretBinding | null | undefined;
  seal: string;
  identity: RuntimeAuthorizationIdentity;
}): Promise<UnsealedRuntimeAuthorization> {
  const secret = await resolveSecret(input.secretBinding);
  if (!secret) return { status: 'missing_secret' };
  let authorization: RuntimeAuthorization;
  try {
    authorization = await unsealRuntimeAuthorization(input.seal, secret, {
      resourceKind: 'cloud-agent-next',
      resourceId: input.identity.sessionId,
      userId: input.identity.userId,
      organizationId: input.identity.orgId,
    });
  } catch {
    return { status: 'invalid_seal' };
  }
  return authorization.state === 'active'
    ? { status: 'active', authorization }
    : { status: 'fresh_authorization_inactive' };
}

export type RecoveryRequest = {
  ownerId: string;
  expectedOldId: string;
  recoveryId: string;
  runtimeAuthorizationSeal: string;
  runtimeToken: string;
};

export type RecoveryOutcome = {
  status: 'recovered' | 'not-needed' | 'denied' | 'busy' | 'retry';
};

export type ReauthorizeRequest = {
  ownerId: string;
  expectedOldId: string;
  runtimeAuthorizationSeal: string;
};

export type RuntimeAuthorizationRecoveryDeny = (reason: RecoveryDenialReason) => {
  status: 'denied';
};

export type RecoverableRuntimeAuthorization =
  | {
      status: 'ready';
      metadata: SessionMetadata;
      authorization: RuntimeAuthorization;
      deny: RuntimeAuthorizationRecoveryDeny;
    }
  | { status: 'denied' };

/**
 * Recovery preflight shared by both session Durable Objects: require stored
 * metadata for the owner, then unseal an active authorization. Denial reporting
 * is returned bound to this session because the reason vocabulary and its
 * session identity are the same for every caller.
 */
export async function loadRecoverableRuntimeAuthorization(
  request: Pick<RecoveryRequest, 'ownerId' | 'runtimeAuthorizationSeal'>,
  metadata: SessionMetadata | null | undefined,
  fallbackSessionId: string | undefined,
  secretBinding: SecretBinding | null | undefined
): Promise<RecoverableRuntimeAuthorization> {
  const deny: RuntimeAuthorizationRecoveryDeny = reason =>
    runtimeAuthorizationRecoveryDenied(metadata?.identity.sessionId ?? fallbackSessionId, reason);

  if (!metadata) return deny('metadata_unavailable');
  if (metadata.identity.userId !== request.ownerId) return deny('owner_mismatch');
  const unsealed = await unsealActiveRuntimeAuthorization({
    secretBinding,
    seal: request.runtimeAuthorizationSeal,
    identity: metadata.identity,
  });
  return unsealed.status === 'active'
    ? { status: 'ready', metadata, authorization: unsealed.authorization, deny }
    : deny(unsealed.status);
}

export async function replaceStoredRuntimeAuthorization(
  request: ReauthorizeRequest,
  metadata: SessionMetadata | null | undefined,
  secretBinding: SecretBinding | null | undefined,
  readStored: () => Promise<unknown>,
  writeStored: (authorization: RuntimeAuthorization) => void | Promise<void>
): Promise<boolean> {
  if (!metadata || metadata.identity.userId !== request.ownerId) return false;
  const unsealed = await unsealActiveRuntimeAuthorization({
    secretBinding,
    seal: request.runtimeAuthorizationSeal,
    identity: metadata.identity,
  });
  if (unsealed.status !== 'active') return false;
  const current = RuntimeAuthorizationSchema.safeParse(await readStored());
  if (!current.success || current.data.id !== request.expectedOldId) return false;
  await writeStored(unsealed.authorization);
  return true;
}

export const RUNTIME_AUTHORIZATION_RESTORE_ERRORS: Record<
  RuntimeAuthorizationUnsealFailure,
  string
> = {
  missing_secret: 'Authentication unavailable',
  invalid_seal: 'Invalid runtime authorization',
  fresh_authorization_inactive: 'Runtime authorization revoked',
};
