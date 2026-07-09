import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { classifyCloudAgentModelBilling } from '@/lib/cloud-agent-next/classify-model-billing';
import { ORGANIZATION_ID_HEADER } from '@/lib/constants';
import { POST } from './route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/drizzle', () => ({ db: {} }));
jest.mock('@/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: jest.fn(),
}));
jest.mock('@/lib/cloud-agent-next/classify-model-billing', () => ({
  classifyCloudAgentModelBilling: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalance = jest.mocked(getBalanceAndOrgSettings);
const mockedClassify = jest.mocked(classifyCloudAgentModelBilling);

function request(body: unknown, headers?: HeadersInit) {
  return new NextRequest('http://localhost:3000/api/profile/cloud-agent-admission', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/profile/cloud-agent-admission', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-1' },
      organizationId: undefined,
      authFailedResponse: null,
    } as never);
    mockedClassify.mockResolvedValue('balance-required');
    mockedGetBalance.mockResolvedValue({ balance: 5 } as never);
  });

  test('does not read balance for a non-balance-required model', async () => {
    mockedClassify.mockResolvedValue('byok');

    const response = await POST(request({ modelId: 'anthropic/claude-sonnet-4' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      classification: 'byok',
      balance: null,
      isDepleted: null,
    });
    expect(mockedGetBalance).not.toHaveBeenCalled();
  });

  test('resolves balance for a balance-required model', async () => {
    mockedGetBalance.mockResolvedValue({ balance: 5 } as never);

    const response = await POST(request({ modelId: 'anthropic/claude-sonnet-4' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      classification: 'balance-required',
      balance: 5,
      isDepleted: false,
    });
    expect(mockedClassify).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'anthropic/claude-sonnet-4', userId: 'user-1' })
    );
  });

  test('marks a depleted balance as depleted', async () => {
    mockedGetBalance.mockResolvedValue({ balance: 0 } as never);

    const response = await POST(request({ modelId: 'anthropic/claude-sonnet-4' }));

    await expect(response.json()).resolves.toEqual({
      classification: 'balance-required',
      balance: 0,
      isDepleted: true,
    });
  });

  test('reads balance against the organization when membership is resolved', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-1' },
      organizationId: 'org-1',
      authFailedResponse: null,
    } as never);

    await POST(
      request({ modelId: 'anthropic/claude-sonnet-4' }, { [ORGANIZATION_ID_HEADER]: 'org-1' })
    );

    expect(mockedClassify).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' })
    );
    expect(mockedGetBalance).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ id: 'user-1' })
    );
  });

  test('propagates the auth failure response without classifying', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      organizationId: undefined,
      authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never);

    const response = await POST(request({ modelId: 'anthropic/claude-sonnet-4' }));

    expect(response.status).toBe(401);
    expect(mockedClassify).not.toHaveBeenCalled();
  });

  test('rejects an invalid body without authenticating', async () => {
    const response = await POST(request({ modelId: '' }));

    expect(response.status).toBe(400);
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedClassify).not.toHaveBeenCalled();
  });

  test('returns a service failure when classification throws', async () => {
    mockedClassify.mockRejectedValue(new Error('catalog unavailable'));

    const response = await POST(request({ modelId: 'anthropic/claude-sonnet-4' }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to check cloud agent admission',
    });
  });
});
