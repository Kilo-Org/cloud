import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type * as InstallStartModule from './install-start';
import type * as PlatformIntegrationsModule from '../db/platform-integrations';
import type * as ResolveOwnerModule from '../resolve-owner';
import type * as MultipleInstallationsModule from './multiple-installations';
import type * as InstallStateModule from './install-state';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'install-start-slot-rule-secret',
}));

jest.mock('../resolve-owner', () => ({
  resolveAuthorizedOwner: jest.fn(),
}));

jest.mock('./multiple-installations', () => ({
  canOrganizationUseMultipleGitHubInstallations: jest.fn(),
}));

jest.mock('../db/platform-integrations', () => ({
  getOrganizationGitHubInstallationSlots: jest.fn(),
}));

jest.mock('../platforms/github/app-selector', () => ({
  getGitHubAppName: () => 'KiloConnect',
  getGitHubAppTypeForOrganization: async () => 'standard',
}));

jest.mock('./install-state', () => ({
  createInstallState: jest.fn(async () => 'install-state-token'),
}));

const { beginGitHubAppInstall } = jest.requireActual<typeof InstallStartModule>('./install-start');
const { resolveAuthorizedOwner } = jest.requireMock<typeof ResolveOwnerModule>('../resolve-owner');
const { canOrganizationUseMultipleGitHubInstallations } = jest.requireMock<
  typeof MultipleInstallationsModule
>('./multiple-installations');
const { getOrganizationGitHubInstallationSlots } = jest.requireMock<
  typeof PlatformIntegrationsModule
>('../db/platform-integrations');
const { createInstallState } = jest.requireMock<typeof InstallStateModule>('./install-state');

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const ctx = { user: { id: 'user-1' } } as never;

const mockOwner = jest.mocked(resolveAuthorizedOwner);
const mockMultiple = jest.mocked(canOrganizationUseMultipleGitHubInstallations);
const mockSlots = jest.mocked(getOrganizationGitHubInstallationSlots);
const mockCreateInstallState = jest.mocked(createInstallState);

function slot(installationId: string | null, appType: 'standard' | 'lite' | null = 'standard') {
  return { installationId, appType };
}

describe('beginGitHubAppInstall organization installation slot rule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOwner.mockResolvedValue({ type: 'org', id: ORGANIZATION_ID });
    mockMultiple.mockReturnValue(false);
    mockSlots.mockResolvedValue([]);
  });

  test('starts an install when no association occupies the organization slot', async () => {
    mockSlots.mockResolvedValue([slot(null)]);

    await expect(
      beginGitHubAppInstall(ctx, { organizationId: ORGANIZATION_ID, returnTo: null })
    ).resolves.toEqual({ token: 'install-state-token', appType: 'standard' });
  });

  test('refuses an install when a live association already occupies the slot', async () => {
    mockSlots.mockResolvedValue([slot('12345')]);

    await expect(
      beginGitHubAppInstall(ctx, { organizationId: ORGANIZATION_ID, returnTo: null })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'This organization already has a GitHub installation. An owner or admin must disconnect it in Kilo before starting another.',
    });
    expect(mockCreateInstallState).not.toHaveBeenCalled();
  });

  test('starts an install for an organization entitled to multiple installations', async () => {
    mockMultiple.mockReturnValue(true);
    mockSlots.mockResolvedValue([slot('12345')]);

    await expect(
      beginGitHubAppInstall(ctx, { organizationId: ORGANIZATION_ID, returnTo: null })
    ).resolves.toEqual({ token: 'install-state-token', appType: 'standard' });
    expect(mockSlots).not.toHaveBeenCalled();
  });

  test('still allows a personal owner install when the organization rule does not apply', async () => {
    mockOwner.mockResolvedValue({ type: 'user', id: 'user-1' });

    await expect(beginGitHubAppInstall(ctx, { returnTo: null })).resolves.toEqual({
      token: 'install-state-token',
      appType: 'standard',
    });
    expect(mockSlots).not.toHaveBeenCalled();
  });
});
