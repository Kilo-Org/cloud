import type { inferRouterOutputs } from '@trpc/server';
import type {
  CloudAgentSessionId,
  FetchedSessionData,
  KiloSessionId,
} from '@kilocode/cloud-agent-sdk';
import type { RootRouter } from '@/routers/root-router';
import { normalizeAlias } from './session-config';

// The fields read here, so the server's unserialized result fits as well.
type SessionWithRuntimeState = Pick<
  inferRouterOutputs<RootRouter>['cliSessionsV2']['getWithRuntimeState'],
  | 'cloud_agent_session_id'
  | 'title'
  | 'organization_id'
  | 'git_url'
  | 'git_branch'
  | 'cloud_agent_worktree_id'
  | 'runtimeState'
  | 'associatedPr'
  | 'total_cost_microdollars'
>;

/** The SDK's view of `cliSessionsV2.getWithRuntimeState`, for the browser and the server. */
export function toFetchedSessionData(
  kiloSessionId: KiloSessionId,
  session: SessionWithRuntimeState
): FetchedSessionData {
  const rs = session.runtimeState;
  return {
    kiloSessionId,
    cloudAgentSessionId: session.cloud_agent_session_id as CloudAgentSessionId | null,
    title: session.title,
    organizationId: session.organization_id,
    gitUrl: session.git_url,
    gitBranch: session.git_branch,
    worktreeId: session.cloud_agent_worktree_id ?? null,
    mode: normalizeAlias(rs?.mode),
    model: rs?.model ?? null,
    variant: rs?.variant ?? null,
    repository: rs?.githubRepo ?? null,
    isInitiated: Boolean(rs?.initiatedAt),
    isPreparingAsync: Boolean(rs && !rs.preparedAt),
    routeReady: rs?.routeReady,
    prompt: rs?.prompt ?? null,
    initialMessageId: rs?.initialMessageId ?? null,
    runtimeAgents: rs?.runtimeAgents,
    associatedPr: session.associatedPr,
    totalCostMicrodollars: session.total_cost_microdollars,
  };
}
