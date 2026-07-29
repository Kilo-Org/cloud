import { describe, expect, it } from 'vitest';
import {
  getAuthValidationQueryKey,
  getGatewayModelsQueryKey,
  getModelPreferencesQueryKey,
  getOrganizationsQueryKey,
  getTabListQueryKey,
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
