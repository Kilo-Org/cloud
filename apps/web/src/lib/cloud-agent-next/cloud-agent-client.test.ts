import { describe, expect, it, jest, beforeEach } from '@jest/globals';

jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: jest.fn(() => 'http://cloud-agent-next'),
}));

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-secret',
}));

jest.mock('@trpc/client', () => ({
  createTRPCClient: jest.fn(() => ({})),
  httpLink: jest.fn(),
  TRPCClientError: class TRPCClientError extends Error {},
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('./cloud-agent-client', () => {
  const createCloudAgentNextClient = jest.fn((_token: string) => ({ marker: 'default' }));
  const createAppBuilderCloudAgentNextClient = jest.fn((_token: string) => ({
    marker: 'appbuilder',
  }));
  return {
    createCloudAgentNextClient,
    createAppBuilderCloudAgentNextClient,
    createCloudAgentNextClientForModel: jest.fn(
      (token: string, model: { isFree: boolean; hasUserByokAvailable: boolean }) =>
        model.isFree || model.hasUserByokAvailable
          ? createAppBuilderCloudAgentNextClient(token)
          : createCloudAgentNextClient(token)
    ),
    rethrowAsPaymentRequired: jest.fn(),
  };
});

const clientModule: {
  createCloudAgentNextClient: jest.Mock;
  createAppBuilderCloudAgentNextClient: jest.Mock;
  createCloudAgentNextClientForModel: (
    token: string,
    model: { isFree: boolean; hasUserByokAvailable: boolean }
  ) => unknown;
} = jest.requireMock('./cloud-agent-client');

const {
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  createAppBuilderCloudAgentNextClient: mockCreateAppBuilderCloudAgentNextClient,
  createCloudAgentNextClientForModel,
} = clientModule;

beforeEach(() => {
  mockCreateCloudAgentNextClient.mockClear();
  mockCreateAppBuilderCloudAgentNextClient.mockClear();
});

// Load the real `closeCloudAgentOrgStreams` (the module mock above does not
// expose it) so the test exercises the actual fetch call, not a stub.
const { closeCloudAgentOrgStreams } = jest.requireActual('./cloud-agent-client') as {
  closeCloudAgentOrgStreams: (userId: string, organizationId: string) => Promise<void>;
};

describe('createCloudAgentNextClientForModel', () => {
  it('returns the default client when the model is paid and has no BYOK', () => {
    const result = createCloudAgentNextClientForModel('token', {
      isFree: false,
      hasUserByokAvailable: false,
    });
    expect(result).toEqual({ marker: 'default' });
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('token');
    expect(mockCreateAppBuilderCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('returns the AppBuilder client when the model is free', () => {
    const result = createCloudAgentNextClientForModel('token', {
      isFree: true,
      hasUserByokAvailable: false,
    });
    expect(result).toEqual({ marker: 'appbuilder' });
    expect(mockCreateAppBuilderCloudAgentNextClient).toHaveBeenCalledWith('token');
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('returns the AppBuilder client when the model is BYOK-capable, even if it is not free', () => {
    const result = createCloudAgentNextClientForModel('token', {
      isFree: false,
      hasUserByokAvailable: true,
    });
    expect(result).toEqual({ marker: 'appbuilder' });
    expect(mockCreateAppBuilderCloudAgentNextClient).toHaveBeenCalledWith('token');
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });
});

describe('closeCloudAgentOrgStreams', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs to the close endpoint with the internal key header and body', async () => {
    const fetchMock = jest
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await closeCloudAgentOrgStreams('usr_1', 'org_1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://cloud-agent-next/internal/streams/close',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-secret',
        },
        body: JSON.stringify({ userId: 'usr_1', organizationId: 'org_1' }),
      })
    );
  });

  it('throws when the close endpoint returns a non-OK response', async () => {
    const fetchMock = jest
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response('boom', { status: 500, statusText: 'Internal Server Error' })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(closeCloudAgentOrgStreams('usr_1', 'org_1')).rejects.toThrow(
      'Cloud Agent stream close failed: 500 Internal Server Error - boom'
    );
  });
});
