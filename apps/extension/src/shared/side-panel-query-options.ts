import type { QueryClient } from '@tanstack/react-query';

export const getAuthValidationQueryKey = (token: string): readonly string[] => [
  'side-panel',
  'auth-validation',
  token,
];

export const getGatewayModelsQueryKey = ({
  organizationId,
  token,
}: {
  readonly organizationId: string | undefined;
  readonly token: string;
}): readonly string[] => ['side-panel', 'gateway-models', token, organizationId ?? 'personal'];

export const getModelPreferencesQueryKey = ({
  organizationId,
  token,
}: {
  readonly organizationId: string | undefined;
  readonly token: string;
}): readonly string[] => ['side-panel', 'model-preferences', token, organizationId ?? 'personal'];

export const getOrganizationsQueryKey = (token: string): readonly string[] => [
  'side-panel',
  'organizations',
  token,
];

export const getTabListQueryKey = (): readonly string[] => ['side-panel', 'tabs'];

/**
 * Session identity for agents cache keys: the stored session token scopes
 * every agents entry next to the selected organization.
 */
export interface AgentsQueryScope {
  readonly organizationId: string | null;
  readonly token: string;
}

const AGENTS_QUERY_ROOT = 'agents';
const AGENTS_NEW_SESSION_QUERY_ROOT = 'agents-new-session';

export const activeSessionsQueryKey = ({ organizationId, token }: AgentsQueryScope) =>
  [AGENTS_QUERY_ROOT, 'active-sessions', token, organizationId] as const;

export const sessionHistoryQueryKey = ({ organizationId, token }: AgentsQueryScope) =>
  [AGENTS_QUERY_ROOT, 'session-history', token, organizationId] as const;

export const sessionSearchQueryKey = ({ organizationId, token }: AgentsQueryScope, query: string) =>
  [AGENTS_QUERY_ROOT, 'session-search', token, organizationId, query] as const;

export const sessionRepositoriesQueryKey = ({ organizationId, token }: AgentsQueryScope) =>
  [AGENTS_NEW_SESSION_QUERY_ROOT, 'repos', token, organizationId] as const;

export const cliInstancesQueryKey = ({ token }: Pick<AgentsQueryScope, 'token'>) =>
  [AGENTS_NEW_SESSION_QUERY_ROOT, 'instances', token] as const;

/** Clears the agents cache namespaces when the identity changes. */
export const removeAccountScopedAgentsQueries = (
  queryClient: Pick<QueryClient, 'removeQueries'>
): void => {
  queryClient.removeQueries({ queryKey: [AGENTS_QUERY_ROOT] });
  queryClient.removeQueries({ queryKey: [AGENTS_NEW_SESSION_QUERY_ROOT] });
};
