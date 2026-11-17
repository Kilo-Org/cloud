import type { FetchedSessionData } from './session-manager';
import type {
  CloudSessionMetadata,
  KiloSessionId,
  CloudAgentSessionId,
  ResolvedSession,
} from './types';

export function sessionViewType(resolved: ResolvedSession): 'cloud-agent' | 'remote' | 'read-only' {
  return resolved.type === 'hosted-native' ? 'cloud-agent' : resolved.type;
}

export function cloudSessionMetadataToFetched(
  kiloSessionId: KiloSessionId,
  cloudAgentSessionId: CloudAgentSessionId,
  metadata: CloudSessionMetadata
): FetchedSessionData {
  if (metadata.sessionId !== cloudAgentSessionId) throw new Error('Cloud Agent session mismatch');
  return {
    kiloSessionId,
    cloudAgentSessionId,
    title: metadata.title ?? null,
    organizationId: metadata.orgId ?? null,
    gitUrl: metadata.gitUrl ?? null,
    gitBranch: metadata.upstreamBranch ?? metadata.branchName ?? null,
    worktreeId: metadata.worktreeId ?? null,
    environmentId: metadata.environmentId ?? null,
    mode: metadata.mode ?? null,
    model: metadata.model ?? null,
    variant: metadata.variant ?? null,
    repository: metadata.githubRepo ?? null,
    isInitiated: Boolean(metadata.initiatedAt),
    isPreparingAsync: !metadata.preparedAt,
    ...(metadata.routeReady === undefined ? {} : { routeReady: metadata.routeReady }),
    prompt: metadata.prompt ?? null,
    initialMessageId: metadata.initialMessageId ?? null,
    ...(metadata.runtimeAgents ? { runtimeAgents: metadata.runtimeAgents } : {}),
    associatedPr: metadata.associatedPr ?? null,
    totalCostMicrodollars: metadata.totalCostMicrodollars ?? null,
    createdOnPlatform: metadata.createdOnPlatform ?? null,
    profileId: metadata.profileId ?? null,
  };
}
