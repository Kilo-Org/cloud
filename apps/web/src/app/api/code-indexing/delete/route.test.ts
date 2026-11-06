import { NextRequest } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { POST } from './route';

const mockAvailability = { enabled: true };

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
  return new NextRequest('http://localhost:3000/api/code-indexing/delete', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/code-indexing/delete request body', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAvailability.enabled = true;
  });

  it('returns 400 for malformed JSON body', async () => {
    const response = await POST(createRequest('not-json{'));

    expect(response.status).toBe(400);
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
      message: 'Invalid JSON body',
    });
  });

  it('returns 400 for an absent body', async () => {
    const response = await POST(createRequest());

    expect(response.status).toBe(400);
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
      message: 'Invalid JSON body',
    });
  });
});
