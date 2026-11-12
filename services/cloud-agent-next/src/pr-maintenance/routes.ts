import type { Hono, Context } from 'hono';
import { TRPCError } from '@trpc/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { normalizeGitUrl } from '@kilocode/worker-utils';
import type { HonoContext } from '../hono-context.js';
import { getPgDb } from '../db/pg.js';
import {
  loadWorkspaceSource,
  sourceWorktreeBranchName,
} from '../router/handlers/session-worktree.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { withDORetry } from '../utils/do-retry.js';
import { readBoundedBody } from '../utils/read-bounded-body.js';
import {
  maintenanceOwnerSchema,
  maintenanceScheduleSchema,
  maintenanceStartSchema,
  maintenanceStatusSchema,
  maintenanceStopSchema,
} from './contracts.js';
import { maintenanceContext, startMaintenanceChat } from './start.js';
import { scheduleMaintenance } from './scheduling.js';

export function registerMaintenanceRoutes(app: Hono<HonoContext>) {
  app.post('/internal/pr-maintenance/:action', async (c: Context<HonoContext>) => {
    const secret = c.env.INTERNAL_API_SECRET;
    const key = c.req.header('x-internal-api-key');
    if (!secret) return c.json({ error: 'maintenance_authentication_unavailable' }, 503);
    if (!key || !timingSafeEqual(key, secret)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await readBoundedBody(c.req.raw, 1_500_000);
    if (body === null) return c.json({ error: 'maintenance_request_too_large' }, 413);
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return c.json({ error: 'maintenance_request_invalid' }, 400);
    }
    try {
      switch (c.req.param('action')) {
        case 'schedule': {
          const parsed = maintenanceScheduleSchema.safeParse(input);
          if (!parsed.success) return c.json({ error: 'maintenance_schedule_invalid' }, 400);
          await scheduleMaintenance(c.env, parsed.data);
          return c.json({ scheduled: true });
        }
        case 'start': {
          const parsed = maintenanceStartSchema.safeParse(input);
          if (!parsed.success) return c.json({ error: 'maintenance_start_invalid' }, 400);
          return c.json(await startMaintenanceChat(c.env, parsed.data));
        }
        case 'workspace': {
          const parsed = maintenanceOwnerSchema.safeParse(input);
          if (!parsed.success) return c.json({ error: 'maintenance_workspace_invalid' }, 400);
          const source = await loadWorkspaceSource(
            getPgDb(c.env),
            maintenanceContext(c.env, parsed.data.userId),
            parsed.data.worktreeId,
            parsed.data.organizationId,
            { allowInteractiveOrigin: true }
          );
          return c.json({
            worktreeId: source.worktreeId,
            repoUrl: normalizeGitUrl(
              source.repository.type === 'github'
                ? `https://github.com/${source.repository.repo}`
                : source.repository.url
            ),
            headRef: sourceWorktreeBranchName(source),
            profileId: source.ownership.profileId ?? null,
            environmentId: source.metadata.environment?.environmentId ?? null,
            model: source.metadata.agent?.model ?? null,
            variant: source.metadata.agent?.variant ?? null,
            purpose: source.metadata.initialMessage?.prompt?.slice(0, 8000) ?? null,
            constraints: [],
            sourceKiloSessionId: source.ownership.kiloSessionId,
            sourceCloudAgentSessionId: source.ownership.cloudAgentSessionId,
          });
        }
        case 'status':
        case 'stop': {
          const parsed = (
            c.req.param('action') === 'stop' ? maintenanceStopSchema : maintenanceStatusSchema
          ).safeParse(input);
          if (!parsed.success) return c.json({ error: 'maintenance_status_invalid' }, 400);
          const { userId, cloudAgentSessionId, messageId } = parsed.data;
          if (
            c.req.param('action') === 'stop' &&
            'watchId' in parsed.data &&
            'attemptId' in parsed.data &&
            typeof parsed.data.watchId === 'string' &&
            typeof parsed.data.attemptId === 'string'
          ) {
            const identity = {
              watchId: parsed.data.watchId,
              attemptId: parsed.data.attemptId,
              messageId,
            };
            await withDORetry(
              () => getSandboxSessionStub(c.env, userId, cloudAgentSessionId),
              stub => stub.stopMaintenanceBeforeRegistration(identity),
              'stopMaintenanceBeforeRegistration'
            );
            return c.json(
              await withDORetry(
                () => getSandboxSessionStub(c.env, userId, cloudAgentSessionId),
                stub => stub.getMaintenanceStatus(messageId),
                'getMaintenanceStatus'
              )
            );
          }
          const status = await withDORetry(
            () => getSandboxSessionStub(c.env, userId, cloudAgentSessionId),
            stub => stub.getMaintenanceStatus(messageId),
            'getMaintenanceStatus'
          );
          if (c.req.param('action') === 'stop' && status !== null) {
            await withDORetry(
              () => getSandboxSessionStub(c.env, userId, cloudAgentSessionId),
              stub => stub.stop(),
              'stop'
            );
            return c.json(
              await withDORetry(
                () => getSandboxSessionStub(c.env, userId, cloudAgentSessionId),
                stub => stub.getMaintenanceStatus(messageId),
                'getMaintenanceStatus'
              )
            );
          }
          return c.json(status);
        }
        default:
          return c.json({ error: 'Not found' }, 404);
      }
    } catch (error) {
      if (error instanceof TRPCError) {
        const status =
          error.code === 'FORBIDDEN'
            ? 403
            : error.code === 'BAD_REQUEST'
              ? 400
              : error.code === 'CONFLICT'
                ? 409
                : 503;
        return c.json({ error: error.message }, status);
      }
      return c.json({ error: 'maintenance_runtime_unavailable' }, 503);
    }
  });
}
