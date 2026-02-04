import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateBalanceOnly,
  extractProcedureName,
  extractOrgIdFromUrl,
  fetchOrgIdForSession,
  BALANCE_REQUIRED_MUTATIONS,
} from './balance-validation.js';
import type { PersistenceEnv } from './persistence/types.js';
import type { Env } from './types.js';

// Mock the session-service module
vi.mock('./session-service.js', () => ({
  fetchSessionMetadata: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    withFields: () => ({ error: vi.fn(), warn: vi.fn() }),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { fetchSessionMetadata } from './session-service.js';

describe('balance-validation', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  const mockEnv = {
    NEXTAUTH_SECRET: 'test-secret',
    KILOCODE_BACKEND_BASE_URL: 'https://app.kilo.ai',
    Sandbox: {},
    CLOUD_AGENT_SESSION: {},
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('validateBalanceOnly', () => {
    describe('balance validation', () => {
      it('returns 402 when balance is depleted', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: 0.5, isDepleted: true }),
        } as Response);

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({
          success: false,
          status: 402,
          message: 'Insufficient credits: $1 minimum required',
        });
      });

      it('returns 402 when balance is below $1', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: 0.99, isDepleted: false }), // Just under $1
        } as Response);

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({
          success: false,
          status: 402,
          message: 'Insufficient credits: $1 minimum required',
        });
      });

      it('returns 402 when balance is zero', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: 0, isDepleted: false }),
        } as Response);

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({
          success: false,
          status: 402,
          message: 'Insufficient credits: $1 minimum required',
        });
      });

      it('returns 402 when balance is negative', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: -5, isDepleted: true }),
        } as Response);

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({
          success: false,
          status: 402,
          message: 'Insufficient credits: $1 minimum required',
        });
      });
    });

    describe('error handling', () => {
      it('returns 500 when balance API returns error', async () => {
        fetchMock.mockResolvedValue({
          ok: false,
          status: 500,
        } as Response);

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({
          success: false,
          status: 500,
          message: 'Failed to verify balance',
        });
      });

      it('returns 500 when fetch throws', async () => {
        fetchMock.mockRejectedValue(new Error('Network error'));

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({
          success: false,
          status: 500,
          message: 'Failed to verify balance',
        });
      });

      it('returns 500 when response JSON is invalid', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('Invalid JSON');
          },
        } as unknown as Response);

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({
          success: false,
          status: 500,
          message: 'Invalid balance response',
        });
      });

      it('returns 402 when balance is not a number', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: 'not-a-number', isDepleted: false }),
        } as Response);

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({
          success: false,
          status: 402,
          message: 'Insufficient credits: $1 minimum required',
        });
      });
    });

    describe('successful validation', () => {
      it('returns success when balance is sufficient', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: 5, isDepleted: false }), // $5
        } as Response);

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({ success: true });
      });

      it('returns success with exactly $1 balance', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: 1, isDepleted: false }), // Exactly $1
        } as Response);

        const result = await validateBalanceOnly('valid-token', undefined, mockEnv);

        expect(result).toEqual({ success: true });
      });

      it('uses default API URL when KILOCODE_BACKEND_BASE_URL not configured', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: 5, isDepleted: false }),
        } as Response);
        const envWithoutBackendUrl = { ...mockEnv, KILOCODE_BACKEND_BASE_URL: undefined };

        const result = await validateBalanceOnly(
          'valid-token',
          undefined,
          envWithoutBackendUrl as Env
        );

        expect(result).toEqual({ success: true });
        // Should use default URL https://api.kilo.ai
        expect(fetchMock).toHaveBeenCalledWith(
          'https://api.kilo.ai/api/profile/balance',
          expect.objectContaining({
            method: 'GET',
          })
        );
      });
    });

    describe('organization header', () => {
      it('includes X-KiloCode-OrganizationId header when orgId provided', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: 5, isDepleted: false }),
        } as Response);

        const orgId = '11111111-2222-3333-4444-555555555555';
        await validateBalanceOnly('valid-token', orgId, mockEnv);

        expect(fetchMock).toHaveBeenCalledWith(
          `${mockEnv.KILOCODE_BACKEND_BASE_URL}/api/profile/balance`,
          expect.objectContaining({
            method: 'GET',
            headers: expect.any(Headers),
          })
        );

        const [, init] = fetchMock.mock.calls[0];
        const headers = init.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer valid-token');
        expect(headers.get('X-KiloCode-OrganizationId')).toBe(orgId);
      });

      it('does not include X-KiloCode-OrganizationId header when orgId not provided', async () => {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({ balance: 5, isDepleted: false }),
        } as Response);

        await validateBalanceOnly('valid-token', undefined, mockEnv);

        const [, init] = fetchMock.mock.calls[0];
        const headers = init.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer valid-token');
        expect(headers.get('X-KiloCode-OrganizationId')).toBeNull();
      });
    });
  });

  describe('extractProcedureName', () => {
    it('extracts procedure name from valid tRPC path', () => {
      expect(extractProcedureName('/trpc/initiateSessionStream')).toBe('initiateSessionStream');
      expect(extractProcedureName('/trpc/sendMessageStream')).toBe('sendMessageStream');
      expect(extractProcedureName('/trpc/deleteSession')).toBe('deleteSession');
    });

    it('handles paths with query strings', () => {
      expect(extractProcedureName('/trpc/initiateSessionStream?batch=1')).toBe(
        'initiateSessionStream'
      );
    });

    it('returns null for non-tRPC paths', () => {
      expect(extractProcedureName('/api/health')).toBeNull();
      expect(extractProcedureName('/health')).toBeNull();
      expect(extractProcedureName('/')).toBeNull();
    });

    it('returns null for malformed tRPC paths', () => {
      expect(extractProcedureName('/trpc')).toBeNull();
      expect(extractProcedureName('/trpc/')).toBeNull();
    });
  });

  describe('extractOrgIdFromUrl', () => {
    it('extracts orgId from basic URL with simple string value', () => {
      const input = { kilocodeOrganizationId: 'org-123' };
      const url = new URL(
        `https://example.com/trpc/test?input=${encodeURIComponent(JSON.stringify(input))}`
      );
      expect(extractOrgIdFromUrl(url)).toBe('org-123');
    });

    it('handles URL-encoded values without double-decoding (regression test)', () => {
      // This canary string was used to detect the original double-decoding bug.
      // When URL-encoded:
      // - `%` in `95%` becomes `%25`
      // - `+` becomes `%2B`
      // If double-decoding occurred, `%25` would incorrectly become `%`
      const canaryString = 'decode test +95% and 75%';
      const input = { kilocodeOrganizationId: canaryString };
      const url = new URL(
        `https://example.com/trpc/test?input=${encodeURIComponent(JSON.stringify(input))}`
      );

      // url.searchParams.get() decodes once, and JSON.parse handles the rest
      // The function should NOT double-decode
      expect(extractOrgIdFromUrl(url)).toBe(canaryString);
    });

    it('returns undefined when input parameter is missing', () => {
      const url = new URL('https://example.com/trpc/test');
      expect(extractOrgIdFromUrl(url)).toBeUndefined();
    });

    it('throws an error when input parameter is invalid JSON', () => {
      const url = new URL('https://example.com/trpc/test?input=not-valid-json');
      expect(() => extractOrgIdFromUrl(url)).toThrow('Failed to parse tRPC input');
    });

    it('returns undefined when kilocodeOrganizationId field is missing from input', () => {
      const input = { sessionId: 'session-456' };
      const url = new URL(
        `https://example.com/trpc/test?input=${encodeURIComponent(JSON.stringify(input))}`
      );
      expect(extractOrgIdFromUrl(url)).toBeUndefined();
    });

    it('returns undefined when kilocodeOrganizationId is not a string', () => {
      const input = { kilocodeOrganizationId: 12345 };
      const url = new URL(
        `https://example.com/trpc/test?input=${encodeURIComponent(JSON.stringify(input))}`
      );
      expect(extractOrgIdFromUrl(url)).toBeUndefined();
    });

    it('returns undefined when input is null', () => {
      const url = new URL(`https://example.com/trpc/test?input=${encodeURIComponent('null')}`);
      expect(extractOrgIdFromUrl(url)).toBeUndefined();
    });
  });

  describe('fetchOrgIdForSession', () => {
    const mockPersistenceEnv = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(),
        get: vi.fn(),
      },
    } as unknown as PersistenceEnv;

    beforeEach(() => {
      vi.mocked(fetchSessionMetadata).mockReset();
    });

    it('returns orgId when session metadata exists', async () => {
      vi.mocked(fetchSessionMetadata).mockResolvedValue({
        version: 1,
        sessionId: 'agent_123',
        orgId: 'org-456',
        userId: 'user-789',
        timestamp: Date.now(),
      });

      const result = await fetchOrgIdForSession(mockPersistenceEnv, 'user-789', 'agent_123');

      expect(result).toBe('org-456');
      expect(fetchSessionMetadata).toHaveBeenCalledWith(
        mockPersistenceEnv,
        'user-789',
        'agent_123'
      );
    });

    it('returns undefined when session metadata does not exist', async () => {
      vi.mocked(fetchSessionMetadata).mockResolvedValue(null);

      const result = await fetchOrgIdForSession(mockPersistenceEnv, 'user-789', 'agent_123');

      expect(result).toBeUndefined();
    });

    it('returns undefined when session metadata has no orgId (personal account)', async () => {
      vi.mocked(fetchSessionMetadata).mockResolvedValue({
        version: 1,
        sessionId: 'agent_123',
        userId: 'user-789',
        timestamp: Date.now(),
      });

      const result = await fetchOrgIdForSession(mockPersistenceEnv, 'user-789', 'agent_123');

      expect(result).toBeUndefined();
    });

    it('returns undefined and logs warning when fetchSessionMetadata throws', async () => {
      vi.mocked(fetchSessionMetadata).mockRejectedValue(new Error('DO unavailable'));

      const result = await fetchOrgIdForSession(mockPersistenceEnv, 'user-789', 'agent_123');

      expect(result).toBeUndefined();
    });
  });

  describe('BALANCE_REQUIRED_MUTATIONS', () => {
    it('contains expected V2 mutation procedures', () => {
      expect(BALANCE_REQUIRED_MUTATIONS.has('initiateFromKilocodeSessionV2')).toBe(true);
      expect(BALANCE_REQUIRED_MUTATIONS.has('sendMessageV2')).toBe(true);
    });

    it('does not contain non-balance-required procedures', () => {
      expect(BALANCE_REQUIRED_MUTATIONS.has('deleteSession')).toBe(false);
      expect(BALANCE_REQUIRED_MUTATIONS.has('getSessionLogs')).toBe(false);
      expect(BALANCE_REQUIRED_MUTATIONS.has('prepareSession')).toBe(false);
    });
  });
});
