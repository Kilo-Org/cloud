import type { CloudAgentEnvironmentSetupRun } from '@kilocode/db/schema';
import {
  getEnvironment,
  isOpenSetupRunStatus,
  type EnvironmentOwner,
  type EnvironmentResponse,
} from '@kilocode/cloud-agent-profile';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { toSetupRunResponse, type SetupRunAgentState } from './response';
import { userCloudAgentClient } from './worker';

async function readEnvironment(
  id: string | null,
  owner: EnvironmentOwner
): Promise<EnvironmentResponse | null> {
  if (!id) return null;
  try {
    return await getEnvironment(db, id, owner);
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export async function setupRunResponse(
  run: CloudAgentEnvironmentSetupRun,
  owner: EnvironmentOwner,
  ctx?: TRPCContext,
  organizationId?: string
) {
  const [draft, target] = await Promise.all([
    readEnvironment(run.draft_environment_id, owner),
    readEnvironment(run.published_environment_id ?? run.target_environment_id, owner),
  ]);
  let agentState: SetupRunAgentState | null = null;
  if (
    ctx &&
    run.cloud_agent_session_id &&
    isOpenSetupRunStatus(run.status) &&
    !['needs_input', 'publish_conflict'].includes(run.status)
  ) {
    agentState = { kind: 'unknown' };
    try {
      const client = await userCloudAgentClient(ctx, organizationId);
      const session = await client.getSession(run.cloud_agent_session_id, organizationId);
      if (session.latestPreparation?.status === 'running' && session.execution === null) {
        agentState = { kind: 'working' };
      } else if (session.latestPreparation?.status === 'failed' && session.execution === null) {
        agentState = {
          kind: 'stopped',
          reason: session.latestPreparation.safeError ?? 'Session preparation failed',
        };
      } else if (session.execution === null) {
        if (run.status === 'running' || run.status === 'verifying') agentState = { kind: 'idle' };
      } else {
        switch (session.execution?.status) {
          case 'pending':
          case 'running':
            agentState = { kind: 'working' };
            break;
          case 'failed':
            agentState = { kind: 'stopped', reason: session.execution?.error ?? 'failed' };
            break;
          case 'interrupted':
            agentState = { kind: 'stopped', reason: 'interrupted' };
            break;
          case 'completed':
            if (run.status === 'running' || run.status === 'verifying')
              agentState = { kind: 'idle' };
        }
      }
    } catch {
      agentState = { kind: 'unknown' };
    }
  }
  return toSetupRunResponse(run, draft, target, agentState);
}
