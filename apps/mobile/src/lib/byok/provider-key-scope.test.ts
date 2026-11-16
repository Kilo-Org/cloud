import { describe, expect, it } from 'vitest';

import {
  providerKeyAddHref,
  providerKeyNewHref,
  providerKeyPermissions,
  providerKeyScope,
  providerKeyScopeInput,
  providerKeysHref,
} from './provider-key-scope';

describe('providerKeyScope', () => {
  it('reads no organization id as the caller’s own keys', () => {
    expect(providerKeyScope(undefined)).toEqual({ kind: 'personal' });
    expect(providerKeyScopeInput({ kind: 'personal' })).toEqual({});
  });

  it('reads an organization id as that organization’s keys', () => {
    expect(providerKeyScope('org_1')).toEqual({ kind: 'organization', organizationId: 'org_1' });
    expect(providerKeyScopeInput({ kind: 'organization', organizationId: 'org_1' })).toEqual({
      organizationId: 'org_1',
    });
  });

  it('carries the scope into every route it opens', () => {
    expect(providerKeysHref({ kind: 'personal' })).toBe('/(app)/(tabs)/(3_profile)/provider-keys');
    expect(providerKeysHref({ kind: 'organization', organizationId: 'org_1' })).toEqual({
      pathname: '/(app)/(tabs)/(3_profile)/provider-keys',
      params: { org: 'org_1' },
    });
    expect(providerKeyAddHref({ kind: 'organization', organizationId: 'org_1' })).toEqual({
      pathname: '/(app)/(tabs)/(3_profile)/provider-key-add',
      params: { org: 'org_1' },
    });
    expect(
      providerKeyNewHref({ kind: 'organization', organizationId: 'org_1' }, 'azure', 'key_1')
    ).toEqual({
      pathname: '/(app)/(tabs)/(3_profile)/provider-key-new',
      params: { provider: 'azure', id: 'key_1', org: 'org_1' },
    });
    expect(providerKeyNewHref({ kind: 'personal' }, 'azure')).toEqual({
      pathname: '/(app)/(tabs)/(3_profile)/provider-key-new',
      params: { provider: 'azure' },
    });
  });
});

describe('providerKeyPermissions', () => {
  it('lets a personal account read and edit its own keys', () => {
    expect(providerKeyPermissions({ kind: 'personal' }, undefined)).toEqual({
      canView: true,
      canEdit: true,
    });
  });

  it('lets every member read an organization’s keys', () => {
    for (const role of ['owner', 'admin', 'billing_manager', 'member'] as const) {
      expect(
        providerKeyPermissions({ kind: 'organization', organizationId: 'org_1' }, role)
      ).toEqual({ canView: true, canEdit: role !== 'member' });
    }
  });

  it('refuses a caller who is not a member of the organization', () => {
    expect(
      providerKeyPermissions({ kind: 'organization', organizationId: 'org_1' }, undefined)
    ).toEqual({ canView: false, canEdit: false });
  });
});
