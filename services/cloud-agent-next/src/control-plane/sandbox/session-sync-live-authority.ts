import { withTimeout } from '@kilocode/worker-utils';
import {
  cloudAgentSyncLiveResultSchema,
  cloudAgentSyncLiveRequestSchema,
  type CloudAgentSyncLiveResult,
} from '@kilocode/worker-utils/cloud-agent-session-sync';
import { z } from 'zod';
import {
  sameRuntimeProxyControlBinding,
  verifyRuntimeCredentialProxyHandle,
} from '../../runtime-credential-proxy.js';
import type { Env } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import {
  lookupAcceptedHandle,
  type AcceptedHandleStorage,
  type AcceptedHandleFence,
} from './accepted-handles.js';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import type { ControlPlaneCredentialSource } from '../../shared/control-plane-protocol.js';
import type { RouteRecord } from './routes.js';
import { scopeGrantId } from './scope-grants.js';
import { buildScopeGrantView } from './scope-view.js';
import { OrganizationAccessRevokedError } from './organization-membership.js';
import {
  sessionSyncLiveRootGrantProofSchema,
  type SessionSyncLiveRootGrantRequest,
  type SessionSyncLiveRootGrantProof,
} from '../session/session-sync-live-root-grant.js';

export const sandboxSessionSyncLiveRequestSchema = z.strictObject({
  authorization: cloudAgentSyncLiveRequestSchema,
  ownerId: z.string().min(1).max(256),
  organizationId: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256),
  kiloSessionId: z.string().min(1).max(256),
  nativeSessionId: z.string().min(1).max(256),
  directory: z.string().min(1).max(4096),
  deadlineAt: z.number().int().positive(),
});
export type SandboxSessionSyncLiveRequest = z.infer<typeof sandboxSessionSyncLiveRequestSchema>;
export type SessionSyncLiveSnapshot = {
  ownerId: string | null;
  fence: AcceptedHandleFence | null;
  harness: string | undefined;
  routes: RouteRecord[];
  grants: SessionCredentialGrant[];
};
export type SessionSyncLiveRootPeer = {
  getSessionSyncLiveRootGrantProof(
    input: SessionSyncLiveRootGrantRequest
  ): Promise<SessionSyncLiveRootGrantProof>;
  getRuntimeProxyDelegationExpiresAt(input: {
    sandboxId: string;
    directory: string;
    kiloSessionId: string;
  }): Promise<number | null>;
};
type Dependencies = {
  env: Pick<Env, 'NEXTAUTH_SECRET'>;
  sandboxId: string;
  storage: AcceptedHandleStorage;
  read: () => Promise<SessionSyncLiveSnapshot>;
  peer: (ownerId: string, sessionId: string) => SessionSyncLiveRootPeer | null;
  requireMembership: (source: ControlPlaneCredentialSource) => Promise<void>;
};

const denied = { type: 'denied', code: 'access_denied' } as const;
const unavailable = { type: 'unavailable', code: 'auth_unavailable' } as const;

function currentRoot(snapshot: SessionSyncLiveSnapshot, request: SandboxSessionSyncLiveRequest) {
  const route = snapshot.routes.find(route => route.sessionId === request.sessionId);
  const grant = snapshot.grants.find(
    grant => route?.grant && scopeGrantId(grant) === scopeGrantId(route.grant)
  );
  if (
    snapshot.ownerId !== request.ownerId ||
    route === undefined ||
    route.state === 'failed' ||
    route.spec.kiloSessionId !== request.kiloSessionId ||
    route.spec.directory !== request.directory ||
    route.credentialSource?.userId !== request.ownerId ||
    route.credentialSource.orgId !== request.organizationId
  )
    return { type: 'denied' } as const;
  if (route.credentialSource.chat?.transport !== 'relay' || snapshot.harness === 'kilo')
    return { type: 'ineligible' } as const;
  if (!grant || !snapshot.fence || !grant.kilo.runtimeProxy) {
    return route.state === 'preparing' && route.attemptDeadlineAt > Date.now()
      ? ({ type: 'pending' } as const)
      : ({ type: 'denied' } as const);
  }
  if (
    grant.expiresAt <= Date.now() ||
    grant.userId !== request.ownerId ||
    grant.orgId !== request.organizationId ||
    grant.directory !== request.directory ||
    !buildScopeGrantView(grant, snapshot.routes).members.some(
      member =>
        member.sessionId === request.sessionId && member.kiloSessionId === request.kiloSessionId
    )
  )
    return { type: 'denied' } as const;
  return {
    type: 'root',
    route,
    source: route.credentialSource,
    grant,
    fence: snapshot.fence,
  } as const;
}

export async function authorizeSessionSyncLive(
  input: unknown,
  dependencies: Dependencies
): Promise<CloudAgentSyncLiveResult> {
  const parsed = sandboxSessionSyncLiveRequestSchema.safeParse(input);
  if (!parsed.success) return denied;
  const request = parsed.data;
  const deadlineAt = Math.min(request.deadlineAt, Date.now() + 4_000);
  const remaining = () => {
    const ms = deadlineAt - Date.now();
    if (ms <= 0) throw new Error('Live authorization deadline elapsed');
    return ms;
  };
  const retry = { maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 500, scope: { deadlineAt } };
  try {
    return await withTimeout(
      (async (): Promise<CloudAgentSyncLiveResult> => {
        const initial = currentRoot(await dependencies.read(), request);
        if (initial.type === 'pending') return unavailable;
        if (initial.type === 'ineligible')
          return { type: 'denied', code: 'hosted_live_not_enabled' };
        if (initial.type !== 'root') return denied;
        const { authorization } = request;
        let handleExpiresAt = Number.POSITIVE_INFINITY;
        if (authorization.type === 'handle') {
          const claims = await verifyRuntimeCredentialProxyHandle(
            dependencies.env,
            authorization.handle
          );
          if (!claims || claims.userId !== request.ownerId) return denied;
          handleExpiresAt = claims.exp * 1000;
          const accepted = await lookupAcceptedHandle(
            dependencies.storage,
            authorization.handle,
            initial.fence
          );
          if (accepted !== undefined) {
            if (
              accepted.scopeGrantId !== scopeGrantId(initial.grant) ||
              accepted.entry.scopeId !== initial.grant.scopeId
            )
              return denied;
            handleExpiresAt = Math.min(handleExpiresAt, accepted.entry.exp);
          } else {
            if (
              initial.grant.scopeId !== request.sessionId &&
              initial.route.state === 'preparing' &&
              initial.route.attemptDeadlineAt > Date.now()
            )
              return unavailable;
            if (
              initial.grant.scopeId !== request.sessionId ||
              claims.sessionId !== request.sessionId ||
              claims.kiloSessionId !== request.kiloSessionId ||
              !initial.grant.kilo.runtimeProxy?.members.some(
                member =>
                  member.sessionId === request.sessionId &&
                  member.kiloSessionId === request.kiloSessionId &&
                  member.handle === authorization.handle
              )
            )
              return denied;
            const expected = {
              ownerId: request.ownerId,
              ...(request.organizationId ? { organizationId: request.organizationId } : {}),
              sessionId: request.sessionId,
              kiloSessionId: request.kiloSessionId,
              sandboxId: dependencies.sandboxId,
              directory: request.directory,
              scopeId: initial.grant.scopeId,
              fence: initial.fence,
            };
            const proof = sessionSyncLiveRootGrantProofSchema.parse(
              await withDORetry(
                () => dependencies.peer(request.ownerId, request.sessionId),
                peer => {
                  if (!peer) throw new Error('Root proof peer unavailable');
                  return withTimeout(
                    peer.getSessionSyncLiveRootGrantProof({
                      ...expected,
                      handle: authorization.handle,
                    }),
                    remaining(),
                    'Root proof timed out'
                  );
                },
                'getSessionSyncLiveRootGrantProof',
                retry
              )
            );
            if (proof.type === 'unavailable') return unavailable;
            if (proof.type !== 'allowed') return denied;
            if (
              proof.ownerId !== expected.ownerId ||
              proof.organizationId !== expected.organizationId ||
              proof.sessionId !== expected.sessionId ||
              proof.kiloSessionId !== expected.kiloSessionId ||
              proof.sandboxId !== expected.sandboxId ||
              proof.directory !== expected.directory ||
              proof.scopeId !== expected.scopeId ||
              !sameRuntimeProxyControlBinding(proof.fence, expected.fence)
            )
              return denied;
            handleExpiresAt = Math.min(handleExpiresAt, proof.expiresAt);
          }
        } else if (
          authorization.userID !== request.ownerId ||
          authorization.organizationID !== request.organizationId ||
          authorization.host.cloudAgentSessionId !== request.sessionId ||
          authorization.native.rootSessionID !== request.kiloSessionId ||
          authorization.native.sessionID !== request.nativeSessionId ||
          authorization.liveIdentity.allocationId !== initial.fence.allocationId ||
          authorization.liveIdentity.providerInstanceId !== initial.fence.providerInstanceId
        )
          return denied;
        const delegationExpiresAt = await withDORetry(
          () => dependencies.peer(request.ownerId, request.sessionId),
          peer => {
            if (!peer) throw new Error('Delegation peer unavailable');
            return withTimeout(
              peer.getRuntimeProxyDelegationExpiresAt({
                sandboxId: dependencies.sandboxId,
                directory: request.directory,
                kiloSessionId: request.kiloSessionId,
              }),
              remaining(),
              'Delegation proof timed out'
            );
          },
          'getSessionSyncLiveDelegation',
          retry
        );
        if (delegationExpiresAt === null || delegationExpiresAt <= Date.now()) return denied;
        await withTimeout(
          dependencies.requireMembership(initial.source),
          remaining(),
          'Membership read timed out'
        );
        const latest = currentRoot(await dependencies.read(), request);
        if (
          latest.type !== 'root' ||
          latest.grant.scopeId !== initial.grant.scopeId ||
          !sameRuntimeProxyControlBinding(initial.fence, latest.fence)
        )
          return denied;
        const expiresAt = Math.min(
          Date.now() + 120_000,
          latest.grant.expiresAt,
          handleExpiresAt,
          delegationExpiresAt
        );
        if (expiresAt <= Date.now()) return denied;
        return cloudAgentSyncLiveResultSchema.parse({
          type: 'allowed',
          authorization: {
            userID: request.ownerId,
            ...(request.organizationId ? { organizationID: request.organizationId } : {}),
            workload: 'cloud-agent',
            host: { cloudAgentSessionId: request.sessionId },
            native: {
              sessionID: request.nativeSessionId,
              rootSessionID: request.kiloSessionId,
              kind: request.nativeSessionId === request.kiloSessionId ? 'root' : 'descendant',
            },
            liveIdentity: {
              allocationId: latest.fence.allocationId,
              providerInstanceId: latest.fence.providerInstanceId,
            },
            expiresAt,
          },
        });
      })(),
      remaining(),
      'Live authorization timed out'
    );
  } catch (error) {
    return error instanceof OrganizationAccessRevokedError ? denied : unavailable;
  }
}
