import { and, eq, isNull, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import {
  cloudAgentSessionScopeAssertionSchema,
  cloudAgentSessionScopeHeaders,
  containedKiloSessionIdSchema,
} from '@kilocode/session-ingest-contracts';
import { hasOrganizationAccess, zodJsonValidator, withDORetry } from '@kilocode/worker-utils';

import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { handleDirectIngestRequest } from '../ingest/direct-ingest';
import { mapSessionEventRow, notifyUserSessionEvent } from '../session-events';
import { resolveAccessibleKiloSession } from '../services/session-access';
import { canCreateCliSessionForUser } from '../services/user-session-admission';
import { isWorktreeDeleting } from '../services/worktree-deletion';
import type { ApiContext } from './api';

const createScopedSessionSchema = z
  .object({
    sessionId: containedKiloSessionIdSchema,
    parentSessionId: containedKiloSessionIdSchema.optional(),
  })
  .strict();

const ingestVersionSchema = z.coerce.number().int().nonnegative().catch(0);

export const cloudAgentSessionScopeApi = new Hono<ApiContext>();

function getSessionScopeAssertion(c: Context<ApiContext>) {
  return cloudAgentSessionScopeAssertionSchema.safeParse({
    cloudAgentSessionId: c.req.header(cloudAgentSessionScopeHeaders.cloudAgentSessionId),
    rootKiloSessionId: c.req.header(cloudAgentSessionScopeHeaders.rootKiloSessionId),
    protocolVersion: c.req.header(cloudAgentSessionScopeHeaders.protocolVersion),
  });
}

function getRequestBodyStream(request: Request): ReadableStream<Uint8Array> {
  const body = request.body as ReadableStream<Uint8Array> | null;
  if (body) return body;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function getOptionalExecutionContext(c: Context<ApiContext>): ExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch (error) {
    if (error instanceof Error && error.message === 'This context has no ExecutionContext') {
      return undefined;
    }
    throw error;
  }
}

cloudAgentSessionScopeApi.post('/session', zodJsonValidator(createScopedSessionSchema), async c => {
  const assertion = getSessionScopeAssertion(c);
  if (!assertion.success) {
    return c.json({ success: false, error: 'Invalid Cloud Agent session scope assertion' }, 400);
  }

  const body = c.req.valid('json');
  if (body.sessionId === assertion.data.rootKiloSessionId) {
    return c.json({ success: false, error: 'Root session must use the public route' }, 400);
  }

  const kiloUserId = c.get('user_id');
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const result = await db.transaction(async tx => {
    if (!(await canCreateCliSessionForUser(tx, kiloUserId))) {
      return { status: 'user_not_admitted' } as const;
    }

    const [root] = await tx
      .select({
        sessionId: cli_sessions_v2.session_id,
        organizationId: cli_sessions_v2.organization_id,
        cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
        worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, assertion.data.rootKiloSessionId),
          eq(cli_sessions_v2.kilo_user_id, kiloUserId),
          eq(cli_sessions_v2.cloud_agent_session_id, assertion.data.cloudAgentSessionId),
          isNull(cli_sessions_v2.parent_session_id),
          or(
            isNull(cli_sessions_v2.cloud_agent_session_scope_id),
            eq(cli_sessions_v2.cloud_agent_session_scope_id, assertion.data.cloudAgentSessionId)
          )
        )
      )
      .limit(1)
      .for('update');

    if (!root || (root.worktreeId && (await isWorktreeDeleting(tx, root.worktreeId)))) {
      return { status: 'root_not_found' } as const;
    }
    if (
      root.organizationId !== null &&
      !(await hasOrganizationAccess(tx, {
        kiloUserId,
        organizationId: root.organizationId,
      }))
    ) {
      return { status: 'root_not_found' } as const;
    }

    if (root.cloudAgentSessionScopeId === null) {
      await tx
        .update(cli_sessions_v2)
        .set({ cloud_agent_session_scope_id: assertion.data.cloudAgentSessionId })
        .where(
          and(
            eq(cli_sessions_v2.session_id, assertion.data.rootKiloSessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId),
            isNull(cli_sessions_v2.cloud_agent_session_scope_id)
          )
        );
    }

    const parentSessionId = body.parentSessionId ?? assertion.data.rootKiloSessionId;
    if (parentSessionId === body.sessionId) return { status: 'conflict' } as const;
    if (parentSessionId !== assertion.data.rootKiloSessionId) {
      const [parent] = await tx
        .select({ sessionId: cli_sessions_v2.session_id })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, parentSessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId),
            eq(cli_sessions_v2.cloud_agent_session_scope_id, assertion.data.cloudAgentSessionId),
            root.organizationId === null
              ? isNull(cli_sessions_v2.organization_id)
              : eq(cli_sessions_v2.organization_id, root.organizationId),
            root.worktreeId
              ? eq(cli_sessions_v2.cloud_agent_worktree_id, root.worktreeId)
              : isNull(cli_sessions_v2.cloud_agent_worktree_id)
          )
        )
        .limit(1);
      if (!parent) return { status: 'conflict' } as const;
    }

    const [created] = await tx
      .insert(cli_sessions_v2)
      .values({
        session_id: body.sessionId,
        kilo_user_id: kiloUserId,
        parent_session_id: parentSessionId,
        organization_id: root.organizationId,
        cloud_agent_session_id: null,
        cloud_agent_session_scope_id: assertion.data.cloudAgentSessionId,
        cloud_agent_worktree_id: root.worktreeId,
      })
      .onConflictDoNothing({
        target: [cli_sessions_v2.session_id, cli_sessions_v2.kilo_user_id],
      })
      .returning();

    if (created) return { status: 'created', row: created } as const;

    const [existing] = await tx
      .select()
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, body.sessionId),
          eq(cli_sessions_v2.kilo_user_id, kiloUserId)
        )
      )
      .limit(1)
      .for('update');

    if (!existing || existing.cloud_agent_session_id !== null) {
      return { status: 'conflict' } as const;
    }
    if (
      c.req.header(cloudAgentSessionScopeHeaders.trustedLineage) === '1' &&
      body.parentSessionId !== undefined &&
      existing.cloud_agent_session_scope_id === null &&
      existing.cloud_agent_worktree_id === null &&
      (existing.parent_session_id === null || existing.parent_session_id === parentSessionId) &&
      (existing.organization_id === null || existing.organization_id === root.organizationId)
    ) {
      const [adopted] = await tx
        .update(cli_sessions_v2)
        .set({
          parent_session_id: parentSessionId,
          cloud_agent_session_scope_id: assertion.data.cloudAgentSessionId,
          cloud_agent_worktree_id: root.worktreeId ?? null,
          ...(existing.organization_id !== root.organizationId
            ? { organization_id: root.organizationId }
            : {}),
        })
        .where(
          and(
            eq(cli_sessions_v2.session_id, body.sessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId),
            isNull(cli_sessions_v2.cloud_agent_session_id),
            isNull(cli_sessions_v2.cloud_agent_session_scope_id),
            isNull(cli_sessions_v2.cloud_agent_worktree_id)
          )
        )
        .returning();
      return adopted
        ? ({ status: 'adopted', row: adopted } as const)
        : ({ status: 'conflict' } as const);
    }
    if (
      existing.parent_session_id === null ||
      existing.cloud_agent_session_scope_id !== assertion.data.cloudAgentSessionId ||
      existing.organization_id !== root.organizationId ||
      (existing.cloud_agent_worktree_id != null &&
        existing.cloud_agent_worktree_id !== (root.worktreeId ?? null))
    ) {
      return { status: 'conflict' } as const;
    }
    if (
      existing.organization_id !== null &&
      !(await hasOrganizationAccess(tx, {
        kiloUserId,
        organizationId: existing.organization_id,
      }))
    ) {
      return { status: 'root_not_found' } as const;
    }
    if (root.worktreeId && existing.cloud_agent_worktree_id === null) {
      const [healed] = await tx
        .update(cli_sessions_v2)
        .set({ cloud_agent_worktree_id: root.worktreeId })
        .where(
          and(
            eq(cli_sessions_v2.session_id, body.sessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId),
            eq(cli_sessions_v2.cloud_agent_session_scope_id, assertion.data.cloudAgentSessionId),
            isNull(cli_sessions_v2.cloud_agent_worktree_id)
          )
        )
        .returning();
      return healed
        ? ({ status: 'adopted', row: healed } as const)
        : ({ status: 'conflict' } as const);
    }
    return { status: 'existing', row: existing } as const;
  });

  if (result.status === 'user_not_admitted') {
    return c.json({ success: false, error: 'User account not found' }, 403);
  }
  if (result.status === 'root_not_found') {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }
  if (result.status === 'conflict') {
    return c.json({ success: false, error: 'session_scope_conflict' }, 409);
  }

  try {
    await withDORetry(
      () => getSessionAccessCacheDO(c.env, { kiloUserId }),
      sessionCache =>
        sessionCache.putValidated({
          sessionId: body.sessionId,
          organizationId: result.row.organization_id,
          cloudAgentSessionScopeId: assertion.data.cloudAgentSessionId,
        }),
      'SessionAccessCacheDO.putValidated'
    );
  } catch (error) {
    console.error('Failed to warm session access cache after scoped session bootstrap', {
      kiloUserId,
      sessionId: body.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (result.status === 'created' || result.status === 'adopted') {
    const session = mapSessionEventRow(result.row);
    notifyUserSessionEvent(
      c.env,
      kiloUserId,
      {
        type: result.status === 'created' ? 'session.created' : 'session.updated',
        data: { source: 'v2', session, changedAt: session.updatedAt },
      },
      getOptionalExecutionContext(c)
    );
  }

  return c.json(
    {
      id: body.sessionId,
      ingestPath: `/api/session/${body.sessionId}/ingest`,
    },
    200
  );
});

cloudAgentSessionScopeApi.post('/session/:sessionId/ingest', async c => {
  const assertion = getSessionScopeAssertion(c);
  if (!assertion.success) {
    return c.json({ success: false, error: 'Invalid Cloud Agent session scope assertion' }, 400);
  }

  const sessionId = containedKiloSessionIdSchema.safeParse(c.req.param('sessionId'));
  if (!sessionId.success || sessionId.data === assertion.data.rootKiloSessionId) {
    return c.json({ success: false, error: 'Invalid child sessionId' }, 400);
  }

  const kiloUserId = c.get('user_id');
  const accessibleSession = await resolveAccessibleKiloSession(c.env, {
    kiloUserId,
    kiloSessionId: sessionId.data,
    expectedCloudAgentSessionScopeId: assertion.data.cloudAgentSessionId,
  });
  if (!accessibleSession) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  const result = await handleDirectIngestRequest({
    env: c.env,
    body: getRequestBodyStream(c.req.raw),
    contentLength: c.req.header('content-length'),
    kiloUserId,
    sessionId: sessionId.data,
    ingestVersion: ingestVersionSchema.parse(c.req.query('v') ?? 0),
    ingestedAt: Date.now(),
    ingestRequestId: crypto.randomUUID(),
    executionContext: getOptionalExecutionContext(c),
  });

  return c.json(result.body, result.status);
});
