import { describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';

jest.mock('@/lib/trpc-route-handler', () => ({
  handleTRPCRequest: jest.fn(),
}));

jest.mock('@/lib/code-indexing/availability.server', () => ({
  isCodeIndexingEnabled: () => false,
  codeIndexingGoneResponse: () =>
    Response.json(
      { error: 'gone', message: 'Managed code indexing is no longer available.' },
      { status: 410 }
    ),
}));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);

describe('POST /api/code-indexing/search', () => {
  test('returns 410 without invoking the tRPC router when the feature is off', async () => {
    const response = await POST(
      new NextRequest('http://localhost:3000/api/code-indexing/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'test', projectId: 'project-1' }),
      })
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: 'gone',
      message: 'Managed code indexing is no longer available.',
    });
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
  });
});
