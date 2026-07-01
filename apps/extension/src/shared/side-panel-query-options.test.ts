import { describe, expect, it } from 'vitest';
import {
  getAuthValidationQueryKey,
  getGatewayModelsQueryKey,
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
  });

  it('uses one tab-list cache entry for the extension runtime', () => {
    expect(getTabListQueryKey()).toStrictEqual(['side-panel', 'tabs']);
  });
});
