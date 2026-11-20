import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@kilocode/db';
import { readmitBenchmarkProfile } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  readmitBenchmarkProfile: jest.fn(),
}));

import { POST } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockReadmit = jest.mocked(readmitBenchmarkProfile);

// Test-fixture boundary: only the fields the route actually reads.
function adminUserFixture(): User {
  return { id: 'admin_123', google_user_email: 'admin@kilocode.ai' } as Partial<User> as User;
}

function postRequest(body: string) {
  return new NextRequest(
    'http://localhost:3000/admin/api/auto-routing/benchmark-registry/readmit',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }
  );
}

describe('POST /admin/api/auto-routing/benchmark-registry/readmit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({
      user: adminUserFixture(),
      authFailedResponse: null,
    });
    mockReadmit.mockResolvedValue({
      status: 200,
      body: {
        refreshed: [{ model: 'vendor/model', variant: 'high' }],
        unavailable: [],
        skipped: [],
      },
    });
  });

  it('forwards the pair and router and returns the worker result', async () => {
    const response = await POST(
      postRequest(
        JSON.stringify({ router: 'frontier', entry: { model: 'vendor/model', variant: 'high' } })
      )
    );
    expect(response.status).toBe(200);
    expect(mockReadmit).toHaveBeenCalledWith(
      { model: 'vendor/model', variant: 'high' },
      'frontier'
    );
    await expect(response.json()).resolves.toEqual({
      refreshed: [{ model: 'vendor/model', variant: 'high' }],
      unavailable: [],
      skipped: [],
    });
  });

  it('defaults to the efficient router', async () => {
    await POST(postRequest(JSON.stringify({ entry: { model: 'vendor/model', variant: null } })));
    expect(mockReadmit).toHaveBeenCalledWith({ model: 'vendor/model', variant: null }, 'efficient');
  });

  it('passes a worker conflict through with its status', async () => {
    mockReadmit.mockResolvedValue({ status: 409, body: { error: 'profile is running' } });
    const response = await POST(
      postRequest(JSON.stringify({ entry: { model: 'vendor/model', variant: null } }))
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'profile is running' });
  });

  it('rejects a body without a concrete pair before proxying', async () => {
    const response = await POST(postRequest(JSON.stringify({ entry: { variant: 'high' } })));
    expect(response.status).toBe(400);
    expect(mockReadmit).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const response = await POST(postRequest('{'));
    expect(response.status).toBe(400);
    expect(mockReadmit).not.toHaveBeenCalled();
  });

  it('returns the auth failure for a non-admin', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false as const, error: 'Forbidden' },
        { status: 403 }
      ),
    });
    const response = await POST(
      postRequest(JSON.stringify({ entry: { model: 'vendor/model', variant: null } }))
    );
    expect(response.status).toBe(403);
    expect(mockReadmit).not.toHaveBeenCalled();
  });
});
