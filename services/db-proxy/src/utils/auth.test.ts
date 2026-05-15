import {
  extractBearerToken,
  verifyAdminToken,
  generateToken,
  verifyToken,
  errorResponse,
  requireAdminAuth,
} from './auth';
import type { Context } from 'hono';
import type { Env } from '../types';

// Mock Hono Context
function createMockContext(env: Partial<Env> = {}): Context<{ Bindings: Env }> {
  const headerMock = jest.fn((name: string) => {
    if (name === 'Authorization') return undefined;
    return undefined;
  });
  return {
    req: {
      header: headerMock,
    },
    env: {
      DB_PROXY_ADMIN_TOKEN: env.DB_PROXY_ADMIN_TOKEN ?? 'test-admin-token',
    } as Env,
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('auth utilities', () => {
  describe('extractBearerToken', () => {
    it('extracts token from valid Bearer header', () => {
      const c = createMockContext();
      (c.req.header as jest.Mock).mockImplementation((name: string) => {
        if (name === 'Authorization') return 'Bearer my-token-123';
        return undefined;
      });

      const token = extractBearerToken(c);

      expect(token).toBe('my-token-123');
    });

    it('returns null for missing Authorization header', () => {
      const c = createMockContext();
      (c.req.header as jest.Mock).mockReturnValue(undefined);

      const token = extractBearerToken(c);

      expect(token).toBeNull();
    });

    it('returns null for non-Bearer Authorization header', () => {
      const c = createMockContext();
      (c.req.header as jest.Mock).mockImplementation((name: string) => {
        if (name === 'Authorization') return 'Basic dXNlcjpwYXNz';
        return undefined;
      });

      const token = extractBearerToken(c);

      expect(token).toBeNull();
    });

    it('returns null for empty Bearer token', () => {
      const c = createMockContext();
      (c.req.header as jest.Mock).mockImplementation((name: string) => {
        if (name === 'Authorization') return 'Bearer ';
        return undefined;
      });

      const token = extractBearerToken(c);

      expect(token).toBe('');
    });
  });

  describe('verifyAdminToken', () => {
    it('returns true for valid token', () => {
      const c = createMockContext({ DB_PROXY_ADMIN_TOKEN: 'correct-token' });
      (c.req.header as jest.Mock).mockImplementation((name: string) => {
        if (name === 'Authorization') return 'Bearer correct-token';
        return undefined;
      });

      const result = verifyAdminToken(c);

      expect(result).toBe(true);
    });

    it('returns false for invalid token', () => {
      const c = createMockContext({ DB_PROXY_ADMIN_TOKEN: 'correct-token' });
      (c.req.header as jest.Mock).mockImplementation((name: string) => {
        if (name === 'Authorization') return 'Bearer wrong-token';
        return undefined;
      });

      const result = verifyAdminToken(c);

      expect(result).toBe(false);
    });

    it('returns false for missing Authorization header', () => {
      const c = createMockContext({ DB_PROXY_ADMIN_TOKEN: 'correct-token' });
      (c.req.header as jest.Mock).mockReturnValue(undefined);

      const result = verifyAdminToken(c);

      expect(result).toBe(false);
    });

    it('returns false for missing admin token in env', () => {
      const c = createMockContext({ DB_PROXY_ADMIN_TOKEN: '' });
      (c.req.header as jest.Mock).mockImplementation((name: string) => {
        if (name === 'Authorization') return 'Bearer any-token';
        return undefined;
      });

      const result = verifyAdminToken(c);

      expect(result).toBe(false);
    });

    it('returns false for undefined admin token in env', () => {
      const c = createMockContext({ DB_PROXY_ADMIN_TOKEN: undefined });
      (c.req.header as jest.Mock).mockImplementation((name: string) => {
        if (name === 'Authorization') return 'Bearer any-token';
        return undefined;
      });

      const result = verifyAdminToken(c);

      expect(result).toBe(false);
    });
  });

  describe('generateToken', () => {
    it('generates a 64-character hex string', () => {
      const token = generateToken();

      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]+$/);
    });

    it('generates different tokens on each call', () => {
      const token1 = generateToken();
      const token2 = generateToken();

      expect(token1).not.toBe(token2);
    });
  });

  describe('verifyToken', () => {
    it('returns true for matching tokens', () => {
      const token = 'abcdef123456';

      const result = verifyToken(token, token);

      expect(result).toBe(true);
    });

    it('returns false for non-matching tokens', () => {
      const result = verifyToken('token1', 'token2');

      expect(result).toBe(false);
    });

    it('returns true for equal empty tokens', () => {
      const result = verifyToken('', '');

      expect(result).toBe(true); // timingSafeEqual returns true for equal empty strings
    });
  });

  describe('errorResponse', () => {
    it('creates error response with correct format', () => {
      const c = createMockContext();
      const response = errorResponse(c, 'TEST_ERROR', 'Test message', 400);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(400);
    });

    it('includes error code and message in body', async () => {
      const c = createMockContext();
      const response = errorResponse(c, 'TEST_ERROR', 'Test message', 400);
      const body = await response.json();

      expect(body).toEqual({
        error: {
          code: 'TEST_ERROR',
          message: 'Test message',
        },
      });
    });
  });

  describe('requireAdminAuth', () => {
    it('returns null for valid admin token', () => {
      const c = createMockContext({ DB_PROXY_ADMIN_TOKEN: 'correct-token' });
      (c.req.header as jest.Mock).mockImplementation((name: string) => {
        if (name === 'Authorization') return 'Bearer correct-token';
        return undefined;
      });

      const result = requireAdminAuth(c);

      expect(result).toBeNull();
    });

    it('returns error response for invalid token', () => {
      const c = createMockContext({ DB_PROXY_ADMIN_TOKEN: 'correct-token' });
      (c.req.header as jest.Mock).mockImplementation((name: string) => {
        if (name === 'Authorization') return 'Bearer wrong-token';
        return undefined;
      });

      const result = requireAdminAuth(c);

      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(401);
    });

    it('returns error response for missing token', () => {
      const c = createMockContext({ DB_PROXY_ADMIN_TOKEN: 'correct-token' });
      (c.req.header as jest.Mock).mockReturnValue(undefined);

      const result = requireAdminAuth(c);

      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(401);
    });
  });
});
