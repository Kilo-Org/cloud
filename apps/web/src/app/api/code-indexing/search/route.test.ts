import { NextRequest } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { POST } from './route';

const mockAvailability = { enabled: false };

jest.mock('@/lib/trpc-route-handler', () => ({ handleTRPCRequest: jest.fn() }));

jest.mock('@/lib/code-indexing/availability.server', () => ({
  isCodeIndexingEnabled: () => mockAvailability.enabled,
  codeIndexingGoneResponse: () =>
    Response.json(
      { error: 'gone', message: 'Managed code indexing is no longer available.' },
      { status: 410 }
    ),
}));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);

function createRequest(body?: string) {
  return new NextRequest('http://localhost:3000/api/code-indexing/search', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/code-indexing/search', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAvailability.enabled = false;
  });

  test('returns 410 without invoking the tRPC router when the feature is off', async () => {
    const response = await POST(
      createRequest(JSON.stringify({ query: 'test', projectId: 'project-1' }))
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: 'gone',
      message: 'Managed code indexing is no longer available.',
    });
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
  });

  test('returns 400 for a malformed JSON body', async () => {
    mockAvailability.enabled = true;
    const response = await POST(createRequest('not-json{'));

    expect(response.status).toBe(400);
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
      message: 'Invalid JSON body',
    });
  });

  test('returns 400 for an absent body', async () => {
    mockAvailability.enabled = true;
    const response = await POST(createRequest());

    expect(response.status).toBe(400);
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
      message: 'Invalid JSON body',
    });
  });
});
