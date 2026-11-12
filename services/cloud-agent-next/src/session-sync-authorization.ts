import { WorkerEntrypoint } from 'cloudflare:workers';
import { withTimeout } from '@kilocode/worker-utils';
import {
  cloudAgentSyncAuthorizationSchema,
  type CloudAgentSyncAuthorization,
} from '@kilocode/worker-utils/cloud-agent-session-sync';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getPgDb } from './db/pg.js';
import { getSandboxSessionStub } from './sandbox-session/session-stub.js';
import { verifyRuntimeCredentialProxyHandle } from './runtime-credential-proxy.js';
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
    if (sessionID !== undefined && !roots.includes(sessionID)) {
      const db = getPgDb(this.env);
      // Stored lineage comes from runtime events, so it cannot claim another user's session.
      const [foreign] = await db
        .select({ sessionId: cli_sessions_v2.session_id })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, sessionID),
            ne(cli_sessions_v2.kilo_user_id, claims.userId)
          )
        )
        .limit(1);
      if (foreign) return null;
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
        if (owned) break;
      }
      // Native capture can arrive before the wrapper's ancestry event. Do not discard pending uploads.
      if (!owned) throw new Error('Native session ownership is not available');
    }
    return cloudAgentSyncAuthorizationSchema.parse({
      userID: claims.userId,
      ...(credential.organizationId ? { organizationID: credential.organizationId } : {}),
      expiresAt: claims.exp * 1000,
    });
  }
}
