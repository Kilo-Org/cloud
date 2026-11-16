import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type * as OrganizationsUtils from '@kilocode/web-shared/routers/organizations/utils';
import type * as HandoffTokenModule from '@/lib/app-shell/handoff-token';
import type * as AppShellRouterModule from './app-shell-router';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { shellUser } from '@/tests/helpers/shell-user.helper';

jest.mock('@/lib/app-shell/handoff-token', () => ({
  createAppShellHandoff: jest.fn(async () => 'minted-token'),
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureMemberOrganizationAccess: jest.fn(async () => 'member'),
}));

// This repo's transform does not hoist `jest.mock` above the static imports, so
// the mocked modules and the module under test are required here, after the
// mocks are registered.
const { ensureMemberOrganizationAccess } =
  jest.requireMock<typeof OrganizationsUtils>('@kilocode/web-shared/routers/organizations/utils');
const { createAppShellHandoff } =
  jest.requireMock<typeof HandoffTokenModule>('@/lib/app-shell/handoff-token');
const { appShellRouter } =
  jest.requireActual<typeof AppShellRouterModule>('./app-shell-router');

const mockMint = jest.mocked(createAppShellHandoff);
const mockEnsureMember = jest.mocked(ensureMemberOrganizationAccess);

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const user = shellUser('user-1');

const createCaller = createCallerFactory(appShellRouter);

describe('appShell.mintHandoff', () => {
  beforeEach(() => {
    mockMint.mockClear();
    mockEnsureMember.mockClear();
  });

  test('mints a hand-off for an allow-listed target and returns the shell path', async () => {
    const caller = createCaller({ user });

    const result = await caller.mintHandoff({ page: 'integration', platform: 'slack' });

    expect(result).toEqual({ path: '/app-shell/handoff?token=minted-token' });
    expect(mockMint).toHaveBeenCalledWith({
      userId: 'user-1',
      targetPath: '/app-shell/integrations/slack',
    });
  });

  test('refuses a target the shell does not host', async () => {
    const caller = createCaller({ user });

    // The app can send any JSON; the schema is the boundary that refuses it.
    const unhostedProvider = { page: 'integration', platform: 'bitbucket' } as const;
    // @ts-expect-error Exercise a provider the app never offers.
    await expect(caller.mintHandoff(unhostedProvider)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const unhostedPage = { page: 'credits' } as const;
    // @ts-expect-error Exercise a page the shell does not host.
    await expect(caller.mintHandoff(unhostedPage)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // A malformed organization id is a runtime refusal: `z.uuid()` rejects it.
    const malformedOrganization = { page: 'github-app', organizationId: 'not-a-uuid' } as const;
    await expect(caller.mintHandoff(malformedOrganization)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockMint).not.toHaveBeenCalled();
  });

  test('checks organization membership before minting an organization target', async () => {
    const caller = createCaller({ user });

    await caller.mintHandoff({ page: 'organization-sso', organizationId: ORGANIZATION_ID });

    expect(mockEnsureMember).toHaveBeenCalledWith(user, ORGANIZATION_ID);
    expect(mockMint).toHaveBeenCalledWith({
      userId: 'user-1',
      targetPath: `/app-shell/organizations/${ORGANIZATION_ID}/sso`,
    });
  });

  test('does not mint for a caller outside the organization', async () => {
    mockEnsureMember.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'UNAUTHORIZED' }));
    const caller = createCaller({ user });

    await expect(
      caller.mintHandoff({ page: 'organization-data-collection', organizationId: ORGANIZATION_ID })
    ).rejects.toBeDefined();
    expect(mockMint).not.toHaveBeenCalled();
  });
});
