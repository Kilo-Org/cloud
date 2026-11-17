import { RuntimeAuthorizationSchema } from '@kilocode/worker-utils/runtime-authorization-contract';
import { z } from 'zod';
import {
  matchesRuntimeProxyGrant,
  runtimeProxyGrantSchema,
  verifyRuntimeCredentialProxyHandle,
} from '../../runtime-credential-proxy.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { Env } from '../../types.js';
import type { ControlPlaneSessionRegistration } from './session-do.js';
import { sessionWorkspace } from './workspace-roots.js';

export const sessionSyncLiveRootContextSchema = z.strictObject({
  ownerId: z.string().min(1).max(256),
  organizationId: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256),
  kiloSessionId: z.string().min(1).max(256),
  sandboxId: z.string().min(1).max(256),
  directory: z.string().min(1).max(4096),
  scopeId: z.string().min(1).max(256),
  fence: z.strictObject({
    plane: z.literal('control'),
    allocationId: z.string().min(1).max(256),
    providerInstanceId: z.string().min(1).max(256),
    connectionId: z.string().min(1).max(256),
    wrapperInstanceId: z.string().min(1).max(256),
  }),
});
export const sessionSyncLiveRootGrantRequestSchema = sessionSyncLiveRootContextSchema.extend({
  handle: z.string().min(1).max(4096),
});
export type SessionSyncLiveRootGrantRequest = z.infer<typeof sessionSyncLiveRootGrantRequestSchema>;
export const sessionSyncLiveRootGrantProofSchema = z.discriminatedUnion('type', [
  sessionSyncLiveRootContextSchema.extend({
    type: z.literal('allowed'),
    expiresAt: z.number().int().positive(),
  }),
  z.strictObject({ type: z.literal('denied') }),
  z.strictObject({ type: z.literal('unavailable') }),
]);
export type SessionSyncLiveRootGrantProof = z.infer<typeof sessionSyncLiveRootGrantProofSchema>;

export async function getSessionSyncLiveRootGrantProof(input: {
  request: unknown;
  env: Pick<Env, 'NEXTAUTH_SECRET'>;
  readState: () => Promise<{
    metadata: SessionMetadata | null;
    registration: ControlPlaneSessionRegistration | null;
    authorization: unknown;
    grant: unknown;
  }>;
  now?: number;
}): Promise<SessionSyncLiveRootGrantProof> {
  const parsed = sessionSyncLiveRootGrantRequestSchema.safeParse(input.request);
  if (!parsed.success) return { type: 'denied' };
  const { handle, ...expected } = parsed.data;
  const claims = await verifyRuntimeCredentialProxyHandle(input.env, handle);
  if (!claims) return { type: 'denied' };
  const state = await input.readState();
  const { metadata, registration } = state;
  if (
    metadata === null ||
    registration === null ||
    metadata.identity.userId !== expected.ownerId ||
    metadata.identity.orgId !== expected.organizationId ||
    metadata.identity.sessionId !== expected.sessionId ||
    metadata.auth.kiloSessionId !== expected.kiloSessionId ||
    metadata.workspace?.sandboxId !== expected.sandboxId ||
    (metadata.workspace?.worktreeId ?? metadata.identity.sessionId) !== expected.scopeId ||
    registration.sandboxId !== expected.sandboxId ||
    registration.spec.sessionId !== expected.sessionId ||
    registration.spec.kiloSessionId !== expected.kiloSessionId ||
    registration.spec.directory !== expected.directory ||
    registration.credentials.userId !== expected.ownerId ||
    registration.credentials.orgId !== expected.organizationId ||
    registration.credentials.kiloSessionId !== expected.kiloSessionId ||
    registration.credentials.scopeId !== expected.scopeId ||
    sessionWorkspace(metadata, undefined).directory !== expected.directory
  )
    return { type: 'denied' };
  const authorization = RuntimeAuthorizationSchema.safeParse(state.authorization);
  const grant = runtimeProxyGrantSchema.safeParse(state.grant);
  const now = input.now ?? Date.now();
  if (!authorization.success || !grant.success) return { type: 'denied' };
  const delegationExpiresAt = Date.parse(authorization.data.delegationExpiresAt);
  if (
    authorization.data.state !== 'active' ||
    delegationExpiresAt <= now ||
    authorization.data.userId !== expected.ownerId ||
    authorization.data.organizationId !== expected.organizationId ||
    authorization.data.resourceId !== expected.sessionId ||
    grant.data.leaseExpiresAt > delegationExpiresAt
  )
    return { type: 'denied' };
  if (
    !matchesRuntimeProxyGrant(grant.data, claims, {
      authorizationId: authorization.data.id,
      sessionId: expected.sessionId,
      kiloSessionId: expected.kiloSessionId,
      userId: expected.ownerId,
      orgId: expected.organizationId,
      fence: expected.fence,
      now,
    })
  )
    return { type: 'denied' };
  return {
    type: 'allowed',
    ...expected,
    expiresAt: Math.min(claims.exp * 1000, delegationExpiresAt),
  };
}
