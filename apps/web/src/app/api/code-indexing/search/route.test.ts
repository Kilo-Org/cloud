import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { POST } from './route';

const availability = { enabled: false };

jest.mock('@/lib/trpc-route-handler', () => ({ handleTRPCRequest: jest.fn() }));

jest.mock('@/lib/code-indexing/availability.server', () => ({
  isCodeIndexingEnabled: () => availability.enabled,
  codeIndexingGoneResponse: () =>
    Response.json(
      { error: 'gone', message: 'Managed code indexing is no longer available.' },
      { status: 410 }
    ),
}));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);

describe('POST /api/code-indexing/search', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    availability.enabled = false;
  });

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

  test('returns 400 for a malformed JSON body', async () => {
    availability.enabled = true;
    const response = await POST(
      new NextRequest('http://localhost:3000/api/code-indexing/search', {
        method: 'POST',
        body: 'not-json{',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    expect(response.status).toBe(400);
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
      message: 'Invalid JSON body',
    });
  });
});
