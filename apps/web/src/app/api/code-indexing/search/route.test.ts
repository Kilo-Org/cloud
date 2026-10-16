import { NextRequest } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { POST } from './route';

jest.mock('@/lib/trpc-route-handler', () => ({ handleTRPCRequest: jest.fn() }));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);

describe('POST /api/code-indexing/search request body', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns 400 for malformed JSON body', async () => {
    const request = new NextRequest('http://localhost:3000/api/code-indexing/search', {
      method: 'POST',
      body: 'not-json{',
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
      message: 'Invalid JSON body',
    });
  });
});
