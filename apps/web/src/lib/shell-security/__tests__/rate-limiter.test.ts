import { describe, it, expect, beforeEach } from '@jest/globals';
import { RATE_LIMIT_PER_DAY } from '../schemas';

// Mock the DB module
const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockWhere = jest.fn();
const mockInsert = jest.fn();
const mockValues = jest.fn();

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return {
        from: (...fArgs: unknown[]) => {
          mockFrom(...fArgs);
          return { where: mockWhere };
        },
      };
    },
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return { values: mockValues };
    },
  },
}));

jest.mock('@kilocode/db/schema', () => ({
  security_advisor_scans: {
    kilo_user_id: 'kilo_user_id',
    created_at: 'created_at',
  },
}));

jest.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  count: () => 'count',
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  gte: (a: unknown, b: unknown) => ({ gte: [a, b] }),
}));

describe('shell security rate limiter (DB-backed)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('allows requests when count is under the limit', async () => {
    mockWhere.mockResolvedValue([{ totalRequests: 2 }]);

    const { checkShellSecurityRateLimit } = await import('../rate-limiter');
    const result = await checkShellSecurityRateLimit('user-1');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMIT_PER_DAY - 2);
  });

  it('blocks when count reaches the limit', async () => {
    mockWhere.mockResolvedValue([{ totalRequests: RATE_LIMIT_PER_DAY }]);

    const { checkShellSecurityRateLimit } = await import('../rate-limiter');
    const result = await checkShellSecurityRateLimit('user-1');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('handles empty result from DB', async () => {
    mockWhere.mockResolvedValue([{ totalRequests: 0 }]);

    const { checkShellSecurityRateLimit } = await import('../rate-limiter');
    const result = await checkShellSecurityRateLimit('user-1');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMIT_PER_DAY);
  });

  it('records a scan via DB insert', async () => {
    mockValues.mockResolvedValue(undefined);

    const { recordShellSecurityScan } = await import('../rate-limiter');
    await recordShellSecurityScan('user-1', 'org-1', {
      apiVersion: '2026-04-01',
      source: { platform: 'openclaw', method: 'plugin', pluginVersion: '1.0.0' },
      audit: {
        ts: 1000,
        summary: { critical: 1, warn: 2, info: 3 },
        findings: [],
      },
    });

    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith({
      kilo_user_id: 'user-1',
      organization_id: 'org-1',
      source_platform: 'openclaw',
      source_method: 'plugin',
      plugin_version: '1.0.0',
      openclaw_version: undefined,
      public_ip: undefined,
      findings_critical: 1,
      findings_warn: 2,
      findings_info: 3,
    });
  });
});
