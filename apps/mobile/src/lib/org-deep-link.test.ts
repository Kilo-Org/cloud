import { describe, expect, it } from 'vitest';

import { reconcileOrgDeepLink } from './org-deep-link';

const orgA = { organizationId: 'org-a', role: 'owner' as const };
const orgB = { organizationId: 'org-b', role: 'member' as const };

describe('reconcileOrgDeepLink', () => {
  it('uses the context organization when no org param is present', () => {
    expect(
      reconcileOrgDeepLink({
        orgParam: undefined,
        contextOrganizationId: 'org-a',
        orgs: [orgA, orgB],
      })
    ).toEqual({
      effectiveOrganizationId: 'org-a',
      validatedOrg: undefined,
      queryOrganizationId: 'org-a',
      shouldPersistOverride: false,
      isResolving: false,
    });
  });

  it('treats an empty org param as no param', () => {
    expect(
      reconcileOrgDeepLink({
        orgParam: '',
        contextOrganizationId: 'org-a',
        orgs: [orgA],
      })
    ).toMatchObject({
      effectiveOrganizationId: 'org-a',
      queryOrganizationId: 'org-a',
      shouldPersistOverride: false,
      isResolving: false,
    });
  });

  it('disables queries and marks resolving while the org list is unsettled', () => {
    expect(
      reconcileOrgDeepLink({
        orgParam: 'org-a',
        contextOrganizationId: 'org-b',
        orgs: undefined,
      })
    ).toEqual({
      effectiveOrganizationId: 'org-a',
      validatedOrg: undefined,
      queryOrganizationId: null,
      shouldPersistOverride: false,
      isResolving: true,
    });
  });

  it('keys queries on the param and requests persist when the param is a membership', () => {
    expect(
      reconcileOrgDeepLink({
        orgParam: 'org-a',
        contextOrganizationId: 'org-b',
        orgs: [orgA, orgB],
      })
    ).toEqual({
      effectiveOrganizationId: 'org-a',
      validatedOrg: orgA,
      queryOrganizationId: 'org-a',
      shouldPersistOverride: true,
      isResolving: false,
    });
  });

  it('never keys queries on context when param resolves to a different org', () => {
    const result = reconcileOrgDeepLink({
      orgParam: 'org-b',
      contextOrganizationId: 'org-a',
      orgs: [orgA, orgB],
    });
    expect(result.queryOrganizationId).toBe('org-b');
    expect(result.queryOrganizationId).not.toBe('org-a');
    expect(result.effectiveOrganizationId).toBe('org-b');
    expect(result.shouldPersistOverride).toBe(true);
  });

  it('disables queries and does not persist when the param is not a membership', () => {
    expect(
      reconcileOrgDeepLink({
        orgParam: 'org-foreign',
        contextOrganizationId: 'org-a',
        orgs: [orgA, orgB],
      })
    ).toEqual({
      effectiveOrganizationId: 'org-foreign',
      validatedOrg: undefined,
      queryOrganizationId: null,
      shouldPersistOverride: false,
      isResolving: false,
    });
  });

  it('disables queries for an invalid param even when the list is empty', () => {
    expect(
      reconcileOrgDeepLink({
        orgParam: 'org-stale',
        contextOrganizationId: null,
        orgs: [],
      })
    ).toMatchObject({
      effectiveOrganizationId: 'org-stale',
      queryOrganizationId: null,
      shouldPersistOverride: false,
      isResolving: false,
    });
  });
});
