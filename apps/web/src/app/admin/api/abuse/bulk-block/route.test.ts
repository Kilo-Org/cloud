import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { bulkBlockUsers } from '@/lib/abuse/bulkBlock';
import { POST } from './route';

jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/abuse/bulkBlock', () => ({ bulkBlockUsers: jest.fn() }));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedBulkBlockUsers = jest.mocked(bulkBlockUsers);

describe('POST /admin/api/abuse/bulk-block request body', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({ user: { id: 'admin-1' } } as never);
  });

  it('returns 400 for malformed JSON body', async () => {
    const request = new NextRequest('http://localhost:3000/admin/api/abuse/bulk-block', {
      method: 'POST',
      body: 'not-json{',
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockedBulkBlockUsers).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: expect.stringContaining('Validation error'),
      foundIds: [],
    });
  });
});
