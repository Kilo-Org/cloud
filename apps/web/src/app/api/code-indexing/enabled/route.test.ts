import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { GET } from './route';
import {
  getUserFromAuth,
  requireStaffAuthorityForRequest,
} from '@kilocode/web-shared/lib/user/server';
import {
  ensureOrganizationAccessAndFetchOrg,
  StaffRequestRefusal,
} from '@kilocode/web-shared/routers/organizations/utils';
import { ADMIN_NETWORK_DENIED_MESSAGE } from '@kilocode/web-shared/lib/admin/admin-network-messages';

/** The one account the configured list enables; see the config mock below. */
const ALLOWLISTED_USER_ID = 'allowlisted-user';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/config.server'),
  CODE_INDEXING_ENABLED_USER_IDS: 'allowlisted-user',
}));

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/user/server'),
  getUserFromAuth: jest.fn(),
  requireStaffAuthorityForRequest: jest.fn(),
}));

jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/routers/organizations/utils'
  ),
  ensureOrganizationAccessAndFetchOrg: jest.fn(),
}));

const mockIsCodeIndexingEnabled = jest.fn(() => true);
jest.mock('@/lib/code-indexing/availability.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/code-indexing/availability.server'),
  isCodeIndexingEnabled: () => mockIsCodeIndexingEnabled(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedRequireStaffAuthorityForRequest = jest.mocked(requireStaffAuthorityForRequest);
const mockedEnsureOrganizationAccessAndFetchOrg = jest.mocked(ensureOrganizationAccessAndFetchOrg);

const PERSONAL_URL = 'http://localhost:3000/api/code-indexing/enabled';
const ORGANIZATION_URL = `${PERSONAL_URL}?organizationId=org-1`;

const STEP_UP = {
  code: 'NOT_ENROLLED',
  actionClass: 'platform_read',
  purpose: 'session',
  maxAgeSeconds: 1800,
  binding: null,
} as const;

function signIn(user: { id: string; is_admin: boolean }, credential = 'session') {
  mockedGetUserFromAuth.mockResolvedValue({ authFailedResponse: null, user, credential } as never);
}

type StaffAuthorityResult = Awaited<ReturnType<typeof requireStaffAuthorityForRequest>>;

/** The adapter's failure result, in the exported `requireStaffAuthorityForRequest` shape. */
function staffRefusal(
  status: number,
  error: string,
  extra: Pick<
    Extract<StaffAuthorityResult, { user: null }>,
    'authorizationRefused' | 'adminNetworkDenial' | 'stepUp'
  >
): StaffAuthorityResult {
  return {
    user: null,
    authFailedResponse: NextResponse.json({ success: false, error }, { status }),
    ...extra,
  };
}

async function get(url: string) {
  const response = await GET(new NextRequest(url));
  return { status: response.status, body: await response.json() };
}

describe('GET /api/code-indexing/enabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCodeIndexingEnabled.mockReturnValue(true);
  });

  test('returns disabled without checking organization settings when the feature is off', async () => {
    mockIsCodeIndexingEnabled.mockReturnValue(false);
    signIn({ id: 'user-1', is_admin: false });

    await expect(get(ORGANIZATION_URL)).resolves.toEqual({
      status: 200,
      body: { enabled: false },
    });
    expect(mockedEnsureOrganizationAccessAndFetchOrg).not.toHaveBeenCalled();
  });

  test('enables the personal index for an account on the configured list without a staff check', async () => {
    signIn({ id: ALLOWLISTED_USER_ID, is_admin: true });

    await expect(get(PERSONAL_URL)).resolves.toEqual({ status: 200, body: { enabled: true } });
    expect(mockedRequireStaffAuthorityForRequest).not.toHaveBeenCalled();
  });

  test('disables the personal index for an ordinary account without a staff check', async () => {
    signIn({ id: 'user-1', is_admin: false });

    await expect(get(PERSONAL_URL)).resolves.toEqual({ status: 200, body: { enabled: false } });
    expect(mockedRequireStaffAuthorityForRequest).not.toHaveBeenCalled();
  });

  test('gives a staff bearer caller the ordinary answer without running the guard', async () => {
    signIn({ id: 'admin-1', is_admin: true }, 'human_bearer');

    await expect(get(PERSONAL_URL)).resolves.toEqual({ status: 200, body: { enabled: false } });
    expect(mockedRequireStaffAuthorityForRequest).not.toHaveBeenCalled();
  });

  test('admits a staff browser session through its one authentication result', async () => {
    const admin = { id: 'admin-1', is_admin: true };
    signIn(admin);
    mockedRequireStaffAuthorityForRequest.mockResolvedValue({
      authFailedResponse: null,
      user: admin,
    } as never);

    await expect(get(PERSONAL_URL)).resolves.toEqual({ status: 200, body: { enabled: true } });
    expect(mockedGetUserFromAuth).toHaveBeenCalledTimes(1);
    expect(mockedRequireStaffAuthorityForRequest).toHaveBeenCalledWith(
      expect.objectContaining({ user: admin, credential: 'session' }),
      expect.objectContaining({
        actionClass: 'platform_read',
        target: { kind: 'user', id: 'admin-1' },
        requestMethod: 'GET',
      })
    );
  });

  test('returns the typed step-up refusal for a staff browser session', async () => {
    signIn({ id: 'admin-1', is_admin: true });
    mockedRequireStaffAuthorityForRequest.mockResolvedValue(
      staffRefusal(403, 'NOT_ENROLLED', { stepUp: STEP_UP })
    );

    await expect(get(PERSONAL_URL)).resolves.toEqual({
      status: 403,
      body: { success: false, error: 'NOT_ENROLLED' },
    });
  });

  test('returns the network refusal for an off-network staff browser session', async () => {
    signIn({ id: 'admin-1', is_admin: true });
    mockedRequireStaffAuthorityForRequest.mockResolvedValue(
      staffRefusal(403, ADMIN_NETWORK_DENIED_MESSAGE, {
        authorizationRefused: true,
        adminNetworkDenial: 'outside-allowlist',
      })
    );

    await expect(get(PERSONAL_URL)).resolves.toEqual({
      status: 403,
      body: { success: false, error: ADMIN_NETWORK_DENIED_MESSAGE },
    });
  });

  test('gives the ordinary answer when the primary row is no longer staff', async () => {
    signIn({ id: 'admin-1', is_admin: true });
    mockedRequireStaffAuthorityForRequest.mockResolvedValue(
      staffRefusal(403, 'Access denied (nonadmin)', { authorizationRefused: true })
    );

    await expect(get(PERSONAL_URL)).resolves.toEqual({ status: 200, body: { enabled: false } });
  });

  test('threads the real request into the organization helper and passes its staff refusal through', async () => {
    const admin = { id: 'admin-1', is_admin: true };
    signIn(admin);
    mockedEnsureOrganizationAccessAndFetchOrg.mockRejectedValue(
      new TRPCError({
        code: 'FORBIDDEN',
        message: 'Admin access required',
        cause: new StaffRequestRefusal(
          NextResponse.json({ success: false, error: 'NOT_ENROLLED' }, { status: 403 }),
          STEP_UP
        ),
      })
    );

    await expect(get(ORGANIZATION_URL)).resolves.toEqual({
      status: 403,
      body: { success: false, error: 'NOT_ENROLLED' },
    });
    expect(mockedGetUserFromAuth).toHaveBeenCalledTimes(1);
    expect(mockedEnsureOrganizationAccessAndFetchOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        user: admin,
        restAuth: expect.objectContaining({ user: admin }),
        auditSurface: 'rest',
        auditMethod: 'GET',
        headersList: expect.any(Headers),
      }),
      'org-1'
    );
  });

  test('reports the organization setting for a member', async () => {
    signIn({ id: 'user-1', is_admin: false });
    mockedEnsureOrganizationAccessAndFetchOrg.mockResolvedValue({
      settings: { code_indexing_enabled: true },
    } as never);

    await expect(get(ORGANIZATION_URL)).resolves.toEqual({
      status: 200,
      body: { enabled: true },
    });
  });

  test('keeps disabled for an ordinary organization refusal', async () => {
    signIn({ id: 'user-1', is_admin: false });
    mockedEnsureOrganizationAccessAndFetchOrg.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'Not a member' })
    );

    await expect(get(ORGANIZATION_URL)).resolves.toEqual({
      status: 200,
      body: { enabled: false },
    });
  });
});
