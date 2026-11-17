import { WorkerEntrypoint } from 'cloudflare:workers';
import { withTimeout } from '@kilocode/worker-utils';
import {
  cloudAgentSyncAuthorizationSchema,
  cloudAgentSyncLiveRequestSchema,
  cloudAgentSyncLiveResultSchema,
  type CloudAgentSyncLiveResult,
  type CloudAgentSyncAuthorization,
} from '@kilocode/worker-utils/cloud-agent-session-sync';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getPgDb } from './db/pg.js';
import { getSandboxSessionStub } from './sandbox-session/session-stub.js';
import {
  verifyRuntimeCredentialProxyHandle,
  type RuntimeProxyHandleClaims,
} from './runtime-credential-proxy.js';
import { getSandboxControlStub } from './sandbox-control/stub.js';
import type { ScopeGrantView } from './control-plane/sandbox/scope-view.js';
import { CurrentSessionMetadataSchema } from './persistence/session-metadata.js';
import { sessionWorkspace } from './control-plane/session/workspace-roots.js';
import { withDORetry } from './utils/do-retry.js';
import type { Env } from './types.js';

const requestSchema = z.strictObject({
  handle: z.string().min(1).max(4096),
  sessionID: z
    .string()
    .regex(/^ses_[A-Za-z0-9_-]+$/)
    .max(256)
    .optional(),
});

/** Binding-only authorization. No human credential or general service secret enters the sandbox. */
export class SessionSyncAuthorization extends WorkerEntrypoint<Env> {
  async authorizeLive(input: unknown): Promise<CloudAgentSyncLiveResult> {
    try {
      return await withTimeout(this.#resolveLive(input), 4_500, 'Live authorization timed out');
    } catch {
      return { type: 'unavailable', code: 'auth_unavailable' };
    }
  }

  async #resolveLive(input: unknown): Promise<CloudAgentSyncLiveResult> {
    const parsed = cloudAgentSyncLiveRequestSchema.safeParse(input);
    if (!parsed.success) return { type: 'denied', code: 'invalid_credential' };
    const authorization = parsed.data;
    const deadlineAt = Date.now() + 4_000;
    const retry = { maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 500, scope: { deadlineAt } };
    let ownerId: string;
    let organizationId: string | undefined;
    let member: { sessionId: string; kiloSessionId: string } | undefined;
    let nativeSessionId: string;
    if (authorization.type === 'handle') {
      const claims = await verifyRuntimeCredentialProxyHandle(this.env, authorization.handle);
      if (!claims) return { type: 'denied', code: 'invalid_credential' };
      const resolved = await withDORetry(
        () => getSandboxSessionStub(this.env, claims.userId, claims.sessionId),
        stub => stub.resolveRuntimeCredentialProxyGrant(authorization.handle),
        'resolveSessionSyncLiveIdentity',
        retry
      );
      if (!resolved || resolved.runtimeAuthorization.userId !== claims.userId)
        return { type: 'denied', code: 'access_denied' };
      ownerId = claims.userId;
      organizationId = resolved.organizationId;
      const members = liveMembers(claims, resolved.scopeView);
      const anchor = members.find(member => member.sessionId === claims.sessionId) ?? members[0];
      if (!anchor) return { type: 'denied', code: 'access_denied' };
      nativeSessionId = authorization.sessionID ?? anchor.kiloSessionId;
      member = members.find(member => member.kiloSessionId === nativeSessionId);
      if (!member) {
        const db = getPgDb(this.env);
        const [owner] = await db
          .select({ userId: cli_sessions_v2.kilo_user_id })
          .from(cli_sessions_v2)
          .where(eq(cli_sessions_v2.session_id, nativeSessionId))
          .orderBy(desc(eq(cli_sessions_v2.kilo_user_id, ownerId)))
          .limit(1);
        if (owner && owner.userId !== ownerId) return { type: 'denied', code: 'access_denied' };
        for (const candidate of members) {
          const owned = await withDORetry(
            () => getSandboxSessionStub(this.env, ownerId, candidate.sessionId),
            stub => stub.hasSessionSyncDescendant(candidate.kiloSessionId, nativeSessionId),
            'resolveSessionSyncLiveDescendant',
            retry
          );
          if (owned) {
            member = candidate;
            break;
          }
        }
        if (!member) {
          const [registeredRoot] = await db
            .select({ sessionId: cli_sessions_v2.cloud_agent_session_id })
            .from(cli_sessions_v2)
            .where(
              and(
                eq(cli_sessions_v2.session_id, nativeSessionId),
                eq(cli_sessions_v2.kilo_user_id, ownerId),
                organizationId
                  ? eq(cli_sessions_v2.organization_id, organizationId)
                  : isNull(cli_sessions_v2.organization_id)
              )
            )
            .limit(1);
          if (!registeredRoot?.sessionId) return { type: 'denied', code: 'access_denied' };
          member = { sessionId: registeredRoot.sessionId, kiloSessionId: nativeSessionId };
        }
      }
    } else {
      ownerId = authorization.userID;
      organizationId = authorization.organizationID;
      const ticketMember = {
        sessionId: authorization.host.cloudAgentSessionId,
        kiloSessionId: authorization.native.rootSessionID,
      };
      member = ticketMember;
      nativeSessionId = authorization.native.sessionID;
      if (authorization.native.kind === 'descendant') {
        const owned = await withDORetry(
          () => getSandboxSessionStub(this.env, ownerId, ticketMember.sessionId),
          stub => stub.hasSessionSyncDescendant(ticketMember.kiloSessionId, nativeSessionId),
          'recheckSessionSyncLiveDescendant',
          retry
        );
        if (!owned) return { type: 'denied', code: 'access_denied' };
      }
    }
    const metadataResult = CurrentSessionMetadataSchema.safeParse(
      await withDORetry(
        () => getSandboxSessionStub(this.env, ownerId, member.sessionId),
        async stub => await stub.getMetadata(),
        'getSessionSyncLiveMetadata',
        retry
      )
    );
    const metadata = metadataResult.success ? metadataResult.data : null;
    if (
      !metadata ||
      metadata.identity.userId !== ownerId ||
      metadata.identity.sessionId !== member.sessionId ||
      metadata.identity.orgId !== organizationId ||
      metadata.auth.kiloSessionId !== member.kiloSessionId
    )
      return { type: 'denied', code: 'access_denied' };
    if (metadata.workspace?.chat?.transport !== 'relay')
      return { type: 'denied', code: 'hosted_live_not_enabled' };
    const sandboxId = metadata.workspace.sandboxId;
    const directory = sessionWorkspace(metadata, undefined).directory;
    if (!sandboxId || !directory) return { type: 'denied', code: 'access_denied' };
    return cloudAgentSyncLiveResultSchema.parse(
      await withDORetry(
        () => getSandboxControlStub(this.env, sandboxId),
        async stub =>
          await stub.authorizeSessionSyncLive({
            authorization,
            ownerId,
            ...(organizationId ? { organizationId } : {}),
            sessionId: member.sessionId,
            kiloSessionId: member.kiloSessionId,
            nativeSessionId,
            directory,
            deadlineAt,
          }),
        'authorizeSessionSyncLive',
        retry
      )
    );
  }

  async authorizeUpload(input: unknown): Promise<CloudAgentSyncAuthorization | null> {
    return withTimeout(
      this.#resolveUpload(input),
      4_500,
      'Cloud Agent upload authorization timed out'
    );
  }

  async #resolveUpload(input: unknown): Promise<CloudAgentSyncAuthorization | null> {
    const deadlineAt = Date.now() + 4_000;
    const retryConfig = {
      maxAttempts: 3,
      baseBackoffMs: 100,
      maxBackoffMs: 500,
      scope: { deadlineAt },
    };
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return null;
    const { handle, sessionID } = parsed.data;
    const claims = await verifyRuntimeCredentialProxyHandle(this.env, handle);
    if (!claims) return null;
    const credential = await withDORetry(
      () => getSandboxSessionStub(this.env, claims.userId, claims.sessionId),
      stub => stub.resolveRuntimeCredentialProxyGrant(handle),
      'resolveSessionSyncUploadAuthorization',
      retryConfig
    );
    if (!credential || credential.runtimeAuthorization.userId !== claims.userId) return null;
    // The handle signature binds its own root; scope members only add roots.
    const roots = [
      ...new Set([claims.kiloSessionId, ...(credential.scopeView?.memberRootKiloSessionIds ?? [])]),
    ];
    let hostedMember = liveMembers(claims, credential.scopeView).find(
      member => member.kiloSessionId === sessionID
    );
    if (sessionID !== undefined && !roots.includes(sessionID)) {
      const db = getPgDb(this.env);
      // Stored lineage comes from runtime events, so it cannot claim another user's session.
      // Any user can add a row for a known ID, so a session is foreign only without the caller's row.
      const [owner] = await db
        .select({ userId: cli_sessions_v2.kilo_user_id })
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, sessionID))
        .orderBy(desc(eq(cli_sessions_v2.kilo_user_id, claims.userId)))
        .limit(1);
      if (owner && owner.userId !== claims.userId) return null;
      const rows = await db
        .select({
          sessionId: cli_sessions_v2.cloud_agent_session_id,
          rootId: cli_sessions_v2.session_id,
        })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.kilo_user_id, claims.userId),
            inArray(cli_sessions_v2.session_id, roots),
            credential.organizationId
              ? eq(cli_sessions_v2.organization_id, credential.organizationId)
              : isNull(cli_sessions_v2.organization_id)
          )
        );
      let owned = false;
      for (const row of rows) {
        if (Date.now() >= deadlineAt) throw new Error('Native session ownership lookup timed out');
        const cloudSessionId = row.sessionId;
        if (!cloudSessionId) continue;
        owned = await withDORetry(
          () => getSandboxSessionStub(this.env, claims.userId, cloudSessionId),
          stub => stub.hasSessionSyncDescendant(row.rootId, sessionID),
          'authorizeSessionSyncDescendant',
          retryConfig
        );
        if (owned) {
          hostedMember = liveMembers(claims, credential.scopeView).find(
            member => member.sessionId === cloudSessionId && member.kiloSessionId === row.rootId
          );
          break;
        }
      }
      // Native capture can arrive before the wrapper's ancestry event. Do not discard pending uploads.
      if (!owned) throw new Error('Native session ownership is not available');
    }
    const metadataResult = CurrentSessionMetadataSchema.safeParse(
      hostedMember === undefined
        ? null
        : await withDORetry(
            () => getSandboxSessionStub(this.env, claims.userId, hostedMember.sessionId),
            async stub => await stub.getMetadata(),
            'getSessionSyncUploadHostingIdentity',
            retryConfig
          )
    );
    const metadata = metadataResult.success ? metadataResult.data : null;
    const host =
      hostedMember !== undefined &&
      metadata?.workspace?.chat?.transport === 'relay' &&
      metadata.identity.userId === claims.userId &&
      metadata.identity.orgId === credential.organizationId &&
      metadata.identity.sessionId === hostedMember?.sessionId &&
      metadata.auth.kiloSessionId === hostedMember.kiloSessionId
        ? { cloudAgentSessionId: hostedMember.sessionId }
        : undefined;
    return cloudAgentSyncAuthorizationSchema.parse({
      userID: claims.userId,
      ...(credential.organizationId ? { organizationID: credential.organizationId } : {}),
      expiresAt: claims.exp * 1000,
      ...(host ? { host } : {}),
    });
  }
}

function liveMembers(claims: RuntimeProxyHandleClaims, scopeView: ScopeGrantView | undefined) {
  return (
    scopeView?.members ?? [{ sessionId: claims.sessionId, kiloSessionId: claims.kiloSessionId }]
  );
}
