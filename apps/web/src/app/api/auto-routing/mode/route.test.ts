import { beforeEach, describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { NextRequest } from 'next/server';
import {
  getAutoRoutingMode,
  updateAutoRoutingMode,
} from '@/lib/ai-gateway/auto-routing-admin-client';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { GET, PUT } from './route';

jest.mock('@/lib/ai-gateway/auto-routing-admin-client');
jest.mock('@/lib/organizations/trial-middleware');
jest.mock('@/lib/user/server');
jest.mock('@/routers/organizations/utils');

const mockedGetAutoRoutingMode = jest.mocked(getAutoRoutingMode);
const mockedUpdateAutoRoutingMode = jest.mocked(updateAutoRoutingMode);
const mockedRequireActiveSubscriptionOrTrial = jest.mocked(requireActiveSubscriptionOrTrial);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);

const USER_ID = 'user-1';
const ORGANIZATION_ID = 'org-1';

function makeRequest(path: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('/api/auto-routing/mode', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);
  });

  test('reads the personal auto-routing mode for the authenticated user', async () => {
    mockedGetAutoRoutingMode.mockResolvedValue({
      status: 200,
      body: {
        ownerType: 'user',
        ownerId: USER_ID,
        mode: 'cost_per_accuracy',
        configuredMode: null,
        defaultMode: 'cost_per_accuracy',
      },
    });

    const response = await GET(makeRequest('/api/auto-routing/mode'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ownerType: 'user',
      ownerId: USER_ID,
      mode: 'cost_per_accuracy',
      configuredMode: null,
      defaultMode: 'cost_per_accuracy',
    });
    expect(mockedGetAutoRoutingMode).toHaveBeenCalledWith({
      ownerType: 'user',
      ownerId: USER_ID,
    });
  });

  test('updates an organization auto-routing mode after membership and entitlement checks', async () => {
    mockedUpdateAutoRoutingMode.mockResolvedValue({
      status: 200,
      body: {
        ownerType: 'org',
        ownerId: ORGANIZATION_ID,
        mode: 'best_accuracy',
        configuredMode: 'best_accuracy',
        defaultMode: 'cost_per_accuracy',
      },
    });

    const response = await PUT(
      makeRequest(`/api/auto-routing/mode?organizationId=${ORGANIZATION_ID}`, {
        mode: 'best_accuracy',
      })
    );

    expect(response.status).toBe(200);
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: USER_ID, is_admin: false }),
      }),
      ORGANIZATION_ID,
      ['owner', 'billing_manager']
    );
    expect(mockedRequireActiveSubscriptionOrTrial).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(mockedUpdateAutoRoutingMode).toHaveBeenCalledWith({
      ownerType: 'org',
      ownerId: ORGANIZATION_ID,
      mode: 'best_accuracy',
    });
  });

  test('clears an organization auto-routing mode override', async () => {
    mockedUpdateAutoRoutingMode.mockResolvedValue({
      status: 200,
      body: {
        ownerType: 'org',
        ownerId: ORGANIZATION_ID,
        mode: 'cost_per_accuracy',
        configuredMode: null,
        defaultMode: 'cost_per_accuracy',
      },
    });

    const response = await PUT(
      makeRequest(`/api/auto-routing/mode?organizationId=${ORGANIZATION_ID}`, { mode: null })
    );

    expect(response.status).toBe(200);
    expect(mockedUpdateAutoRoutingMode).toHaveBeenCalledWith({
      ownerType: 'org',
      ownerId: ORGANIZATION_ID,
      mode: null,
    });
  });

  test('maps organization authorization failures to HTTP 401', async () => {
    mockedEnsureOrganizationAccess.mockRejectedValue(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      })
    );

    const response = await PUT(
      makeRequest(`/api/auto-routing/mode?organizationId=${ORGANIZATION_ID}`, {
        mode: 'best_accuracy',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'You do not have access to this organization',
    });
    expect(mockedUpdateAutoRoutingMode).not.toHaveBeenCalled();
  });

  test('maps missing organization entitlements to HTTP 404', async () => {
    mockedRequireActiveSubscriptionOrTrial.mockRejectedValue(
      new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization subscription not found',
      })
    );

    const response = await PUT(
      makeRequest(`/api/auto-routing/mode?organizationId=${ORGANIZATION_ID}`, {
        mode: 'best_accuracy',
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Organization subscription not found',
    });
    expect(mockedUpdateAutoRoutingMode).not.toHaveBeenCalled();
  });
});
