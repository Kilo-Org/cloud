import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitHubOrganizationInstallationLookupResult } from '@/lib/admin/github-installation-lookup';
import {
  getUninstallTarget,
  GitHubInstallationLookupResult,
  LocalAssociationTable,
  uninstallConfirmationCopy,
} from './GitHubInstallationLookup';

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
      id: '123e4567-e89b-42d3-a456-426614174000',
      appType: 'standard',
      installationId: '123',
      accountLogin: 'acme-tools',
      accountId: '456',
      status: 'active',
      suspendedAt: null,
      authInvalid: false,
      updatedAt: '2026-09-03T13:00:00.000Z',
      owner: {
        type: 'organization',
        id: '223e4567-e89b-42d3-a456-426614174000',
        name: 'Acme Tools',
      },
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
    expect(html).toContain('/admin/organizations/223e4567-e89b-42d3-a456-426614174000');
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

  it('only enables the install-wide action for a live, actual record with complete identity', () => {
    const target = getUninstallTarget(result, result.records[0]);
    const candidateTarget = getUninstallTarget(result, result.records[1]);
    const ownerlessTarget = getUninstallTarget(result, result.records[2]);
    const html = renderToStaticMarkup(
      React.createElement(GitHubInstallationLookupResult, {
        result,
        onUninstall: () => {},
      })
    );

    expect(target).toMatchObject({
      appType: 'standard',
      installationId: '123',
      accountId: '456',
      owner: { type: 'organization', id: '223e4567-e89b-42d3-a456-426614174000' },
    });
    expect(candidateTarget).toBeNull();
    expect(ownerlessTarget).toBeNull();
    expect(html).toContain('Uninstall GitHub App');
    expect(html).toContain('Not eligible');
  });

  it('allows suspended actual installations and preserves arbitrary OAuth owner IDs', () => {
    const suspendedResult = {
      ...result,
      records: [
        {
          ...result.records[0],
          owner: { type: 'user' as const, id: 'oauth|github|9/with:any-id', name: 'OAuth user' },
          suspendedAt: '2026-09-03T13:00:00.000Z',
        },
      ],
      apps: [
        {
          ...result.apps[0],
          reason: 'suspended' as const,
          installation: {
            ...result.apps[0].installation!,
            suspendedAt: '2026-09-03T13:00:00.000Z',
          },
        },
        result.apps[1],
      ],
    } satisfies GitHubOrganizationInstallationLookupResult;

    expect(getUninstallTarget(suspendedResult, suspendedResult.records[0])).toMatchObject({
      owner: { type: 'user', id: 'oauth|github|9/with:any-id' },
    });
  });

  it('refuses duplicate effective app associations and unknown live checks', () => {
    const duplicateResult = {
      ...result,
      records: [
        result.records[0],
        { ...result.records[0], id: '323e4567-e89b-42d3-a456-426614174000', appType: null },
      ],
    };
    expect(getUninstallTarget(duplicateResult, duplicateResult.records[0])).toBeNull();
    expect(getUninstallTarget({ ...result, apps: [] }, result.records[0])).toBeNull();
  });

  it('uses irreversible confirmation copy that names the access impact and recovery path', () => {
    expect(uninstallConfirmationCopy.description).toContain(
      'This removes the GitHub App installation from GitHub.'
    );
    expect(uninstallConfirmationCopy.impact).toContain(
      'All repositories served by this GitHub installation lose app access.'
    );
    expect(uninstallConfirmationCopy.impact).toContain('Kilo history and settings are retained.');
    expect(uninstallConfirmationCopy.impact).toContain(
      'Reinstall the app through GitHub to restore access.'
    );
  });
});
