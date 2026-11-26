import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { PUT } from './route';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  ensureOrganizationAccessAndFetchOrg,
  StaffRequestRefusal,
} from '@kilocode/web-shared/routers/organizations/utils';
import { getIndexStorage } from '@/lib/code-indexing/storage';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/user/server'),
  getUserFromAuth: jest.fn(),
}));

jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/routers/organizations/utils'
  ),
  ensureOrganizationAccessAndFetchOrg: jest.fn(),
}));

jest.mock('@/lib/code-indexing/availability.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/code-indexing/availability.server'),
  isCodeIndexingEnabled: () => true,
}));

jest.mock('@/lib/code-indexing/storage', () => ({ getIndexStorage: jest.fn() }));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedEnsureOrganizationAccessAndFetchOrg = jest.mocked(ensureOrganizationAccessAndFetchOrg);
const mockedGetIndexStorage = jest.mocked(getIndexStorage);

const ORGANIZATION_ID = '6f1c2b8e-0d3a-4b8e-9a51-1c2d3e4f5a6b';

function upload(organizationId: string | null = ORGANIZATION_ID): NextRequest {
  const form = new FormData();
  form.set('file', new File(['export const a = 1;\n'], 'a.ts'));
  if (organizationId) form.set('organizationId', organizationId);
  form.set('projectId', 'acme/app');
  form.set('filePath', 'src/a.ts');
  form.set('fileHash', 'hash-1');
  return new NextRequest('http://localhost:3000/api/code-indexing/upsert-by-file', {
    method: 'PUT',
    body: form,
  });
}

describe('PUT /api/code-indexing/upsert-by-file', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('answers an unauthenticated request with the auth refusal and reads nothing', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      ),
    } as never);

    const response = await PUT(upload());

    expect(response.status).toBe(401);
    expect(mockedEnsureOrganizationAccessAndFetchOrg).not.toHaveBeenCalled();
    expect(mockedGetIndexStorage).not.toHaveBeenCalled();
  });

  test('admits organization staff as a write of this request and passes its refusal through before any index change', async () => {
    const admin = { id: 'admin-1', is_admin: true };
    mockedGetUserFromAuth.mockResolvedValue({
      authFailedResponse: null,
      user: admin,
      credential: 'session',
    } as never);
    mockedEnsureOrganizationAccessAndFetchOrg.mockRejectedValue(
      new TRPCError({
        code: 'FORBIDDEN',
        message: 'Admin access required',
        cause: new StaffRequestRefusal(
          NextResponse.json({ success: false, error: 'MFA_REQUIRED' }, { status: 403 }),
          undefined
        ),
      })
    );

    const response = await PUT(upload());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ success: false, error: 'MFA_REQUIRED' });
    expect(mockedGetUserFromAuth).toHaveBeenCalledTimes(1);
    expect(mockedEnsureOrganizationAccessAndFetchOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        user: admin,
        restAuth: expect.objectContaining({ user: admin }),
        auditSurface: 'rest',
        auditMethod: 'PUT',
        headersList: expect.any(Headers),
      }),
      ORGANIZATION_ID,
      undefined
    );
    expect(mockedGetIndexStorage).not.toHaveBeenCalled();
  });

  test('answers a staff bearer without the personal entitlement with the documented 403', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      authFailedResponse: null,
      user: { id: 'admin-1', is_admin: true },
      credential: 'human_bearer',
    } as never);

    const response = await PUT(upload(null));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Code indexing is not enabled for this account',
      message: 'Code indexing is not enabled for this account',
    });
    expect(mockedGetIndexStorage).not.toHaveBeenCalled();
  });

  test('answers an organization with indexing switched off with the documented 403', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      authFailedResponse: null,
      user: { id: 'member-1', is_admin: false },
      credential: 'human_bearer',
    } as never);
    mockedEnsureOrganizationAccessAndFetchOrg.mockResolvedValue({
      id: ORGANIZATION_ID,
      settings: { code_indexing_enabled: false },
    } as never);

    const response = await PUT(upload());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Code indexing is not enabled for this organization',
      message: 'Code indexing is not enabled for this organization',
    });
    expect(mockedGetIndexStorage).not.toHaveBeenCalled();
  });

  test('keeps 500 for an unexpected failure', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      authFailedResponse: null,
      user: { id: 'member-1', is_admin: false },
      credential: 'human_bearer',
    } as never);
    mockedEnsureOrganizationAccessAndFetchOrg.mockRejectedValue(new Error('database unavailable'));

    const response = await PUT(upload());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Internal Server Error',
      message: 'database unavailable',
    });
    expect(mockedGetIndexStorage).not.toHaveBeenCalled();
  });
});
