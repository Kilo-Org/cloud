import { and, eq, isNull, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import {
  cloudAgentSessionScopeAssertionSchema,
  cloudAgentSessionScopeHeaders,
  cloudAgentSessionScopeProtocolVersion,
  cloudAgentSessionScopeProtocolVersionV2,
  cloudAgentSessionScopeV2Headers,
  containedKiloSessionIdSchema,
  parseCloudAgentSessionScopeV2Headers,
  type CloudAgentSessionScopeAssertion,
  type CloudAgentSessionScopeV2,
} from '@kilocode/session-ingest-contracts';
import { hasOrganizationAccess, zodJsonValidator, withDORetry } from '@kilocode/worker-utils';

import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { handleDirectIngestRequest } from '../ingest/direct-ingest';
import { mapSessionEventRow, notifyUserSessionEvent } from '../session-events';
import {
  resolveScopedChildSession,
  resolveScopedCreateParent,
  scopedSessionCondition,
  worktreeScopeCondition,
} from '../services/cloud-agent-worktree-scope';
import { getSessionExport } from '../services/session-export';
import { resolveAccessibleKiloSession } from '../services/session-access';
import { applyReportedSessionTitle, reportSessionTitleSchema } from '../services/session-title';
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

type ScopedCreateBody = z.infer<typeof createScopedSessionSchema>;

export const cloudAgentSessionScopeApi = new Hono<ApiContext>();

type ScopedRequestAssertion =
  | { kind: 'v1'; data: CloudAgentSessionScopeAssertion }
  | { kind: 'v2'; data: CloudAgentSessionScopeV2 }
  | { kind: 'invalid' };

function getScopeAssertion(c: Context<ApiContext>): ScopedRequestAssertion {
  const protocolVersion = c.req.header(cloudAgentSessionScopeHeaders.protocolVersion);
  if (protocolVersion === cloudAgentSessionScopeProtocolVersion) {
    const parsed = cloudAgentSessionScopeAssertionSchema.safeParse({
      cloudAgentSessionId: c.req.header(cloudAgentSessionScopeHeaders.cloudAgentSessionId),
      rootKiloSessionId: c.req.header(cloudAgentSessionScopeHeaders.rootKiloSessionId),
      protocolVersion,
    });
    return parsed.success ? { kind: 'v1', data: parsed.data } : { kind: 'invalid' };
  }
  if (protocolVersion !== cloudAgentSessionScopeProtocolVersionV2) return { kind: 'invalid' };

  const parsed = parseCloudAgentSessionScopeV2Headers({
    worktreeId: c.req.header(cloudAgentSessionScopeV2Headers.worktreeId),
    expectedOrganization: c.req.header(cloudAgentSessionScopeV2Headers.expectedOrganization),
    memberRootKiloSessionIds: c.req.header(
      cloudAgentSessionScopeV2Headers.memberRootKiloSessionIds
    ),
  });
  return parsed.kind === 'ok' ? { kind: 'v2', data: parsed.scope } : { kind: 'invalid' };
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

function invalidAssertion(c: Context<ApiContext>) {
  return c.json({ success: false, error: 'Invalid Cloud Agent session scope assertion' }, 400);
}

async function handleV1Create(
  c: Context<ApiContext>,
  assertion: CloudAgentSessionScopeAssertion,
  body: ScopedCreateBody
) {
  if (body.sessionId === assertion.rootKiloSessionId) {
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
          eq(cli_sessions_v2.session_id, assertion.rootKiloSessionId),
          eq(cli_sessions_v2.kilo_user_id, kiloUserId),
          eq(cli_sessions_v2.cloud_agent_session_id, assertion.cloudAgentSessionId),
          isNull(cli_sessions_v2.parent_session_id),
          or(
            isNull(cli_sessions_v2.cloud_agent_session_scope_id),
            eq(cli_sessions_v2.cloud_agent_session_scope_id, assertion.cloudAgentSessionId)
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
        .set({ cloud_agent_session_scope_id: assertion.cloudAgentSessionId })
        .where(
          and(
            eq(cli_sessions_v2.session_id, assertion.rootKiloSessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId),
            isNull(cli_sessions_v2.cloud_agent_session_scope_id)
          )
        );
    }

    const parentSessionId = body.parentSessionId ?? assertion.rootKiloSessionId;
    if (parentSessionId === body.sessionId) return { status: 'conflict' } as const;
    if (parentSessionId !== assertion.rootKiloSessionId) {
      const [parent] = await tx
        .select({ sessionId: cli_sessions_v2.session_id })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, parentSessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId),
            eq(cli_sessions_v2.cloud_agent_session_scope_id, assertion.cloudAgentSessionId),
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
        cloud_agent_session_scope_id: assertion.cloudAgentSessionId,
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
          cloud_agent_session_scope_id: assertion.cloudAgentSessionId,
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
      existing.cloud_agent_session_scope_id !== assertion.cloudAgentSessionId ||
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
            eq(cli_sessions_v2.cloud_agent_session_scope_id, assertion.cloudAgentSessionId),
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

  return respondToV1Create(c, assertion, body.sessionId, result);
}

async function handleV2Create(
  c: Context<ApiContext>,
  assertion: CloudAgentSessionScopeV2,
  body: ScopedCreateBody
) {
  const parentSessionId = body.parentSessionId;
  if (parentSessionId === undefined) {
    return c.json({ success: false, error: 'parentSessionId is required' }, 400);
  }
  if (
    parentSessionId === body.sessionId ||
    assertion.memberRootKiloSessionIds.includes(body.sessionId)
  ) {
    return c.json({ success: false, error: 'session_scope_conflict' }, 409);
  }

  const kiloUserId = c.get('user_id');
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const result = await db.transaction(async tx => {
    if (!(await canCreateCliSessionForUser(tx, kiloUserId))) {
      return { status: 'user_not_admitted' } as const;
    }

    const parentResolution = await resolveScopedCreateParent(tx, {
      kiloUserId,
      parentSessionId,
      scope: assertion,
    });
    if (parentResolution.kind !== 'ok') return { status: 'parent_not_found' } as const;
    const { parent, memberRoot, memberRootScopeId } = parentResolution;
    const childScopeId = parent.cloudAgentSessionScopeId ?? memberRootScopeId;

    const [lockedRoot] = await tx
      .select({ sessionId: cli_sessions_v2.session_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, memberRoot.sessionId),
          worktreeScopeCondition(kiloUserId, assertion),
          isNull(cli_sessions_v2.parent_session_id)
        )
      )
      .limit(1)
      .for('update');
    if (!lockedRoot) return { status: 'root_not_found' } as const;

    if (await isWorktreeDeleting(tx, assertion.worktreeId)) {
      return { status: 'worktree_deleting' } as const;
    }

    if (memberRoot.cloudAgentSessionScopeId === null && memberRoot.cloudAgentSessionId !== null) {
      await tx
        .update(cli_sessions_v2)
        .set({ cloud_agent_session_scope_id: memberRoot.cloudAgentSessionId })
        .where(
          and(
            eq(cli_sessions_v2.session_id, memberRoot.sessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId),
            isNull(cli_sessions_v2.cloud_agent_session_scope_id)
          )
        );
    }

    const [created] = await tx
      .insert(cli_sessions_v2)
      .values({
        session_id: body.sessionId,
        kilo_user_id: kiloUserId,
        parent_session_id: parentSessionId,
        organization_id: parent.organizationId,
        cloud_agent_session_id: null,
        cloud_agent_session_scope_id: childScopeId,
        cloud_agent_worktree_id: assertion.worktreeId,
      })
      .onConflictDoNothing({
        target: [cli_sessions_v2.session_id, cli_sessions_v2.kilo_user_id],
      })
      .returning();

    if (created) return { status: 'created', row: created, scopeId: childScopeId } as const;

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
      existing.parent_session_id === null ||
      existing.cloud_agent_session_scope_id !== childScopeId ||
      existing.organization_id !== parent.organizationId ||
      existing.cloud_agent_worktree_id !== assertion.worktreeId
    ) {
      return { status: 'conflict' } as const;
    }
    return { status: 'existing', row: existing, scopeId: childScopeId } as const;
  });

  if (result.status === 'user_not_admitted') {
    return c.json({ success: false, error: 'User account not found' }, 403);
  }
  if (result.status === 'root_not_found' || result.status === 'worktree_deleting') {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }
  if (result.status === 'parent_not_found' || result.status === 'conflict') {
    return c.json({ success: false, error: 'session_scope_conflict' }, 409);
  }

  await warmScopedSessionAccessCache(c, {
    kiloUserId,
    sessionId: body.sessionId,
    organizationId: result.row.organization_id,
    cloudAgentSessionScopeId: result.scopeId,
  });

  if (result.status === 'created') {
    const session = mapSessionEventRow(result.row);
    notifyUserSessionEvent(
      c.env,
      kiloUserId,
      {
        type: 'session.created',
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
}

async function warmScopedSessionAccessCache(
  c: Context<ApiContext>,
  params: {
    kiloUserId: string;
    sessionId: string;
    organizationId: string | null;
    cloudAgentSessionScopeId: string | null;
  }
): Promise<void> {
  try {
    await withDORetry(
      () => getSessionAccessCacheDO(c.env, { kiloUserId: params.kiloUserId }),
      sessionCache =>
        sessionCache.putValidated({
          sessionId: params.sessionId,
          organizationId: params.organizationId,
          cloudAgentSessionScopeId: params.cloudAgentSessionScopeId,
        }),
      'SessionAccessCacheDO.putValidated'
    );
  } catch (error) {
    console.error('Failed to warm session access cache after scoped session bootstrap', {
      kiloUserId: params.kiloUserId,
      sessionId: params.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function respondToV1Create(
  c: Context<ApiContext>,
  assertion: CloudAgentSessionScopeAssertion,
  sessionId: string,
  result:
    | { status: 'user_not_admitted' }
    | { status: 'root_not_found' }
    | { status: 'conflict' }
    | { status: 'created'; row: typeof cli_sessions_v2.$inferSelect }
    | { status: 'adopted'; row: typeof cli_sessions_v2.$inferSelect }
    | { status: 'existing'; row: typeof cli_sessions_v2.$inferSelect }
) {
  if (result.status === 'user_not_admitted') {
    return c.json({ success: false, error: 'User account not found' }, 403);
  }
  if (result.status === 'root_not_found') {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }
  if (result.status === 'conflict') {
    return c.json({ success: false, error: 'session_scope_conflict' }, 409);
  }

  await warmScopedSessionAccessCache(c, {
    kiloUserId: c.get('user_id'),
    sessionId,
    organizationId: result.row.organization_id,
    cloudAgentSessionScopeId: assertion.cloudAgentSessionId,
  });

  if (result.status === 'created' || result.status === 'adopted') {
    const session = mapSessionEventRow(result.row);
    notifyUserSessionEvent(
      c.env,
      c.get('user_id'),
      {
        type: result.status === 'created' ? 'session.created' : 'session.updated',
        data: { source: 'v2', session, changedAt: session.updatedAt },
      },
      getOptionalExecutionContext(c)
    );
  }

  return c.json(
    {
      id: sessionId,
      ingestPath: `/api/session/${sessionId}/ingest`,
    },
    200
  );
}

async function handleV1Ingest(c: Context<ApiContext>, assertion: CloudAgentSessionScopeAssertion) {
  const sessionId = containedKiloSessionIdSchema.safeParse(c.req.param('sessionId'));
  if (!sessionId.success || sessionId.data === assertion.rootKiloSessionId) {
    return c.json({ success: false, error: 'Invalid child sessionId' }, 400);
  }

  const kiloUserId = c.get('user_id');
  const accessibleSession = await resolveAccessibleKiloSession(c.env, {
    kiloUserId,
    kiloSessionId: sessionId.data,
    expectedCloudAgentSessionScopeId: assertion.cloudAgentSessionId,
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
}

async function handleV2Ingest(c: Context<ApiContext>, assertion: CloudAgentSessionScopeV2) {
  const sessionId = containedKiloSessionIdSchema.safeParse(c.req.param('sessionId'));
  if (!sessionId.success) {
    return c.json({ success: false, error: 'Invalid child sessionId' }, 400);
  }

  const kiloUserId = c.get('user_id');
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const resolution = await resolveScopedChildSession(db, {
    kiloUserId,
    sessionId: sessionId.data,
    scope: assertion,
  });
  if (resolution.kind !== 'ok') {
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
}

cloudAgentSessionScopeApi.post('/session', zodJsonValidator(createScopedSessionSchema), async c => {
  const assertion = getScopeAssertion(c);
  if (assertion.kind === 'invalid') return invalidAssertion(c);
  const body = c.req.valid('json');
  if (assertion.kind === 'v1') return handleV1Create(c, assertion.data, body);
  return handleV2Create(c, assertion.data, body);
});

cloudAgentSessionScopeApi.post('/session/:sessionId/ingest', async c => {
  const assertion = getScopeAssertion(c);
  if (assertion.kind === 'invalid') return invalidAssertion(c);
  if (assertion.kind === 'v1') return handleV1Ingest(c, assertion.data);
  return handleV2Ingest(c, assertion.data);
});

cloudAgentSessionScopeApi.get('/session/:sessionId/export', async c => {
  const assertion = getScopeAssertion(c);
  if (assertion.kind !== 'v2') {
    return c.json({ success: false, error: 'Cloud Agent session scope protocol v2 required' }, 400);
  }

  const sessionId = containedKiloSessionIdSchema.safeParse(c.req.param('sessionId'));
  if (!sessionId.success) {
    return c.json({ success: false, error: 'Invalid sessionId' }, 400);
  }

  const kiloUserId = c.get('user_id');
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const resolution = await resolveScopedChildSession(db, {
    kiloUserId,
    sessionId: sessionId.data,
    scope: assertion.data,
  });
  if (resolution.kind !== 'ok') {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  const exported = await getSessionExport(c.env, sessionId.data, kiloUserId);
  if (exported.status !== 'ok') {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }
  return c.body(exported.stream, 200, {
    'content-type': 'application/json; charset=utf-8',
  });
});

cloudAgentSessionScopeApi.post('/session/:sessionId/title', async c => {
  const assertion = getScopeAssertion(c);
  if (assertion.kind !== 'v2') {
    return c.json({ success: false, error: 'Cloud Agent session scope protocol v2 required' }, 400);
  }

  const sessionId = containedKiloSessionIdSchema.safeParse(c.req.param('sessionId'));
  if (!sessionId.success) {
    return c.json({ success: false, error: 'Invalid sessionId' }, 400);
  }

  const bodyParse = reportSessionTitleSchema.safeParse(await c.req.json().catch(() => null));
  if (!bodyParse.success) {
    return c.json({ success: false, error: 'Invalid body', issues: bodyParse.error.issues }, 400);
  }

  const kiloUserId = c.get('user_id');
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const resolution = await resolveScopedChildSession(db, {
    kiloUserId,
    sessionId: sessionId.data,
    scope: assertion.data,
  });
  if (resolution.kind !== 'ok') {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  const scope = scopedSessionCondition(kiloUserId, assertion.data, resolution.rootScopeId);

  const result = await applyReportedSessionTitle(db, {
    sessionId: sessionId.data,
    kiloUserId,
    input: bodyParse.data,
    scope,
  });
  if (result.kind === 'not_found') {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }
  if (result.kind === 'refused') {
    return c.json({ applied: false }, 200);
  }

  const session = mapSessionEventRow(result.row);
  notifyUserSessionEvent(
    c.env,
    kiloUserId,
    {
      type: 'session.updated',
      data: { source: 'v2', session, changedAt: session.updatedAt },
    },
    getOptionalExecutionContext(c)
  );

  return c.json({ title: session.title ?? bodyParse.data.title, applied: true }, 200);
});
