import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  activeSessionsQueryKey,
  cliInstancesQueryKey,
  getAuthValidationQueryKey,
  getGatewayModelsQueryKey,
  getModelPreferencesQueryKey,
  getOrganizationsQueryKey,
  getTabListQueryKey,
  removeAccountScopedAgentsQueries,
  sessionHistoryQueryKey,
  sessionRepositoriesQueryKey,
  sessionSearchQueryKey,
} from './side-panel-query-options';

describe('side panel query keys', () => {
  it('separates cache entries by auth and selected organization', () => {
    expect(getAuthValidationQueryKey('token-a')).not.toStrictEqual(
      getAuthValidationQueryKey('token-b')
    );
    expect(getOrganizationsQueryKey('token-a')).not.toStrictEqual(
      getOrganizationsQueryKey('token-b')
    );
    expect(
      getGatewayModelsQueryKey({ organizationId: undefined, token: 'token-a' })
    ).not.toStrictEqual(getGatewayModelsQueryKey({ organizationId: 'org-1', token: 'token-a' }));
    expect(
      getModelPreferencesQueryKey({ organizationId: undefined, token: 'token-a' })
    ).not.toStrictEqual(getModelPreferencesQueryKey({ organizationId: 'org-1', token: 'token-a' }));
  });

  it('builds model-preferences keys for personal and org scopes', () => {
    expect(
      getModelPreferencesQueryKey({ organizationId: undefined, token: 'token-a' })
    ).toStrictEqual(['side-panel', 'model-preferences', 'token-a', 'personal']);
    expect(
      getModelPreferencesQueryKey({ organizationId: 'org-1', token: 'token-a' })
    ).toStrictEqual(['side-panel', 'model-preferences', 'token-a', 'org-1']);
  });

  it('uses one tab-list cache entry for the extension runtime', () => {
    expect(getTabListQueryKey()).toStrictEqual(['side-panel', 'tabs']);
  });
});

const personalFirst = { organizationId: null, token: 'token-a' };
const personalSecond = { organizationId: null, token: 'token-b' };

describe('agents query keys', () => {
  it('keys the active session list by token and organization', () => {
    expect(activeSessionsQueryKey(personalFirst)).toStrictEqual([
      'agents',
      'active-sessions',
      'token-a',
      null,
    ]);
    expect(activeSessionsQueryKey({ organizationId: 'org-123', token: 'token-a' })).toStrictEqual([
      'agents',
      'active-sessions',
      'token-a',
      'org-123',
    ]);
  });

  it('keys history, search, repositories and instances by token', () => {
    expect(sessionHistoryQueryKey(personalFirst)).toStrictEqual([
      'agents',
      'session-history',
      'token-a',
      null,
    ]);
    expect(sessionSearchQueryKey(personalFirst, 'fix login')).toStrictEqual([
      'agents',
      'session-search',
      'token-a',
      null,
      'fix login',
    ]);
    expect(sessionRepositoriesQueryKey(personalFirst)).toStrictEqual([
      'agents-new-session',
      'repos',
      'token-a',
      null,
    ]);
    expect(cliInstancesQueryKey(personalFirst)).toStrictEqual([
      'agents-new-session',
      'instances',
      'token-a',
    ]);
  });

  it('keys each signed-in session separately in the personal organization', () => {
    expect(activeSessionsQueryKey(personalFirst)).not.toStrictEqual(
      activeSessionsQueryKey(personalSecond)
    );
    expect(sessionHistoryQueryKey(personalFirst)).not.toStrictEqual(
      sessionHistoryQueryKey(personalSecond)
    );
    expect(sessionSearchQueryKey(personalFirst, 'q')).not.toStrictEqual(
      sessionSearchQueryKey(personalSecond, 'q')
    );
    expect(sessionRepositoriesQueryKey(personalFirst)).not.toStrictEqual(
      sessionRepositoriesQueryKey(personalSecond)
    );
    expect(cliInstancesQueryKey(personalFirst)).not.toStrictEqual(
      cliInstancesQueryKey(personalSecond)
    );
  });

  it('clears the agents namespaces and keeps unrelated cache entries', () => {
    const queryClient = new QueryClient();
    const agentsKeys = [
      activeSessionsQueryKey(personalFirst),
      sessionHistoryQueryKey(personalSecond),
      sessionSearchQueryKey(personalFirst, 'q'),
      sessionRepositoriesQueryKey(personalSecond),
      cliInstancesQueryKey(personalFirst),
    ];
    const unrelatedKey = ['side-panel', 'auth-validation', 'token-a'];

    for (const key of agentsKeys) {
      queryClient.setQueryData(key, { sessions: [] });
    }
    queryClient.setQueryData(unrelatedKey, { status: 'signedIn' });

    removeAccountScopedAgentsQueries(queryClient);

    for (const key of agentsKeys) {
      expect(queryClient.getQueryData(key)).toBeUndefined();
    }
    expect(queryClient.getQueryData(unrelatedKey)).toStrictEqual({ status: 'signedIn' });
  });
});
