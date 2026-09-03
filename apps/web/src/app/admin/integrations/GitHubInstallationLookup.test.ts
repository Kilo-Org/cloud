import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitHubOrganizationInstallationLookupResult } from '@/lib/admin/github-installation-lookup';
import { GitHubInstallationLookupResult, LocalAssociationTable } from './GitHubInstallationLookup';

const result = {
  organization: 'acme-tools',
  checkedAt: '2026-09-03T14:00:00.000Z',
  apps: [
    {
      appType: 'standard',
      status: 'installed',
      installation: {
        id: '123',
        accountId: '456',
        accountLogin: 'acme-tools',
        accountType: 'Organization',
        suspendedAt: null,
        repositorySelection: 'selected',
      },
    },
    { appType: 'lite', status: 'unknown', reason: 'request_timeout' },
  ],
  records: [
    {
      id: 'actual-record',
      appType: 'standard',
      installationId: '123',
      accountLogin: 'acme-tools',
      accountId: '456',
      status: 'active',
      suspendedAt: null,
      authInvalid: false,
      updatedAt: '2026-09-03T13:00:00.000Z',
      owner: { type: 'organization', id: 'org/id', name: 'Acme Tools' },
      association: 'actual',
    },
    {
      id: 'candidate-record',
      appType: null,
      installationId: null,
      accountLogin: null,
      accountId: null,
      status: null,
      suspendedAt: '2026-09-02T13:00:00.000Z',
      authInvalid: true,
      updatedAt: '2026-09-03T12:00:00.000Z',
      owner: { type: 'user', id: 'user/id', name: null },
      association: 'candidate',
    },
    {
      id: 'unlinked-record',
      appType: 'lite',
      installationId: '789',
      accountLogin: 'other-account',
      accountId: '987',
      status: 'pending',
      suspendedAt: null,
      authInvalid: false,
      updatedAt: '2026-09-03T11:00:00.000Z',
      owner: null,
      association: 'candidate',
    },
  ],
  recordsTruncated: true,
} satisfies GitHubOrganizationInstallationLookupResult;

describe('GitHubInstallationLookupResult', () => {
  it('renders live state separately from local records and preserves operational anomalies', () => {
    const html = renderToStaticMarkup(
      React.createElement(GitHubInstallationLookupResult, { result })
    );

    expect(html).toContain('Live GitHub App checks');
    expect(html).toContain('Installed');
    expect(html).toContain('Repository scope');
    expect(html).toContain('selected');
    expect(html).toContain('Unknown');
    expect(html).toContain('Local recorded associations');
    expect(html).toContain('Actual match');
    expect(html).toContain('Candidate match');
    expect(html).toContain('Authentication invalid');
    expect(html).toContain('No owner linked');
    expect(html).toContain('Results truncated');
    expect(html).toContain('/admin/organizations/org%2Fid');
    expect(html).toContain('/admin/users/user%2Fid');
  });

  it('does not present an ambiguous GitHub 404 as a confirmed uninstall', () => {
    const html = renderToStaticMarkup(
      React.createElement(GitHubInstallationLookupResult, {
        result: {
          ...result,
          apps: [{ appType: 'standard', status: 'not_found', reason: 'not_found_for_app' }],
          records: [],
        },
      })
    );

    expect(html).toContain('No installation found');
    expect(html).toContain('organization may not exist or may have been renamed');
    expect(html).toContain('does not confirm an uninstall');
    expect(html).not.toContain('Not installed');
  });

  it('renders a specific empty local-record state without inferring a global installation state', () => {
    const html = renderToStaticMarkup(React.createElement(LocalAssociationTable, { records: [] }));

    expect(html).toContain('No local association records matched this lookup.');
    expect(html).not.toContain('Not installed');
  });
});
