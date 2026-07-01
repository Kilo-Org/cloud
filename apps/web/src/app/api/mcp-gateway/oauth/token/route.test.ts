import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';

const mockNativeExchangeToken = jest.fn<(input: unknown) => Promise<unknown>>();
const mockNativeHasRefreshToken = jest.fn<(refreshToken: string) => Promise<boolean>>();
const mockGatewayExchangeToken = jest.fn<(input: unknown) => Promise<unknown>>();

jest.mock('@/lib/mcp-gateway/services', () => ({
  createGatewayServices: () => ({
    config: { appBaseUrl: 'http://localhost:3000' },
    nativeMcpTokenService: {
      exchangeToken: mockNativeExchangeToken,
      hasRefreshToken: mockNativeHasRefreshToken,
    },
    tokenService: { exchangeToken: mockGatewayExchangeToken },
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/mcp-gateway/oauth/token', () => {
  test('returns a stable invalid_request response for malformed form data', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/token', {
        method: 'POST',
        body: 'malformed',
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'Request body is malformed',
    });
  });

  test('rejects duplicate OAuth singleton form parameters', async () => {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'first-code',
      redirect_uri: 'http://127.0.0.1:60424/callback',
      client_id: 'mcp:client',
      code_verifier:
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk',
    });
    form.append('code', 'second-code');
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/token', {
        method: 'POST',
        body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });

  test('routes native refresh requests that omit resource by token ownership', async () => {
    mockNativeHasRefreshToken.mockResolvedValue(true);
    mockNativeExchangeToken.mockResolvedValue({
      access_token: 'native-access',
      token_type: 'bearer',
    });

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'native-refresh-token',
      client_id: 'mcp:client',
    });
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/token', {
        method: 'POST',
        body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    );

    await expect(response.json()).resolves.toEqual({
      access_token: 'native-access',
      token_type: 'bearer',
    });
    expect(mockNativeHasRefreshToken).toHaveBeenCalledWith('native-refresh-token');
    expect(mockNativeExchangeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          grant_type: 'refresh_token',
          refresh_token: 'native-refresh-token',
        }),
      })
    );
    expect(mockGatewayExchangeToken).not.toHaveBeenCalled();
  });

  test('keeps non-native refresh requests without resource on the gateway service', async () => {
    mockNativeHasRefreshToken.mockResolvedValue(false);
    mockGatewayExchangeToken.mockResolvedValue({
      access_token: 'gateway-access',
      token_type: 'bearer',
    });

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'gateway-refresh-token',
      client_id: 'mcp:client',
    });
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/token', {
        method: 'POST',
        body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    );

    await expect(response.json()).resolves.toEqual({
      access_token: 'gateway-access',
      token_type: 'bearer',
    });
    expect(mockNativeHasRefreshToken).toHaveBeenCalledWith('gateway-refresh-token');
    expect(mockNativeExchangeToken).not.toHaveBeenCalled();
    expect(mockGatewayExchangeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          grant_type: 'refresh_token',
          refresh_token: 'gateway-refresh-token',
        }),
      })
    );
  });
});
