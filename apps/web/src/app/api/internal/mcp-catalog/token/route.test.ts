import { NextRequest } from 'next/server';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import {
  DEFAULT_BENCHMARK_ORG_ID,
  DEFAULT_BENCHMARK_USER_ID,
} from '@kilocode/auto-routing-contracts';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  MCP_CATALOG_TOKEN_SECRET: 'catalog-secret',
}));

const mockRows: unknown[] = [];
const mockMembershipRows: unknown[] = [];
let mockSelectCallCount = 0;
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => {
      const callIndex = mockSelectCallCount++;
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(callIndex === 0 ? mockRows : mockMembershipRows),
          }),
        }),
      };
    },
  },
}));

jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateApiToken: jest.fn(() => 'minted-token'),
}));

const mockGetBenchmarkConfig = jest.fn();
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getBenchmarkConfig: () => mockGetBenchmarkConfig(),
}));

import { POST } from './route';

const mockGenerateApiToken = jest.mocked(generateApiToken);

function createRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/internal/mcp-catalog/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// A saved config with no user/org override, which is what the benchmark runner
// falls back to the contracts defaults from.
function noIdentityOverride() {
  mockGetBenchmarkConfig.mockResolvedValue({ status: 200, body: { config: null } });
}

function eligibleAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: DEFAULT_BENCHMARK_USER_ID,
    is_bot: true,
    api_token_pepper: 'pepper',
    blocked_at: null,
    blocked_reason: null,
    ...overrides,
  };
}

describe('POST /api/internal/mcp-catalog/token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.length = 0;
    mockMembershipRows.length = 0;
    mockSelectCallCount = 0;
    noIdentityOverride();
  });

  it('returns 401 without the bearer secret', async () => {
    mockRows.push({ id: DEFAULT_BENCHMARK_USER_ID, api_token_pepper: 'pepper' });
    const res = await POST(createRequest());
    expect(res.status).toBe(401);
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('returns 401 with the wrong bearer secret', async () => {
    const res = await POST(createRequest({ authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('returns 404 when the benchmark service account does not exist', async () => {
    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));
    expect(res.status).toBe(404);
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('returns 404 when the benchmark organization membership is missing', async () => {
    mockRows.push(eligibleAccount());
    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));
    expect(res.status).toBe(404);
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  // The default account does not exist in production, so falling back on a
  // worker error would report the missing-user symptom instead of the real
  // cause, which is exactly the bug this route fixes.
  it('returns 502, not a default-user 404, when the benchmark worker errors', async () => {
    mockGetBenchmarkConfig.mockResolvedValue({
      status: 500,
      body: { error: 'Auto routing benchmark worker is not configured' },
    });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('Auto routing benchmark worker is not configured');
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('returns 502 when the benchmark worker is unreachable', async () => {
    mockGetBenchmarkConfig.mockRejectedValue(new Error('fetch failed'));

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('unreachable');
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  // The token carries the account's pepper and organization claims, so the mint
  // holds the identity to the internal-bot rules instead of minting for whatever
  // the worker config names.
  it.each([
    ['is_bot is false', { is_bot: false }, 'not a bot user'],
    ['blocked_at is set', { blocked_at: '2026-10-01T00:00:00.000Z' }, 'blocked'],
    ['blocked_reason is set', { blocked_reason: 'manual block' }, 'blocked'],
    ['the pepper is empty', { api_token_pepper: '  ' }, 'no API token pepper'],
    ['the pepper is null', { api_token_pepper: null }, 'no API token pepper'],
  ])('returns 403 when %s', async (_label, overrides, message) => {
    mockRows.push(eligibleAccount(overrides));
    mockMembershipRows.push({ role: 'owner' });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain(message);
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it.each(['billing_manager', 'admin'])('returns 403 for the %s organization role', async role => {
    mockRows.push(eligibleAccount());
    mockMembershipRows.push({ role });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('organization role is not supported');
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('mints a 1h benchmarking token scoped to the benchmark organization', async () => {
    const user = eligibleAccount();
    mockRows.push(user);
    mockMembershipRows.push({ role: 'owner' });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      token: string;
      userId: string;
      organizationId: string;
      expiresAt: string;
    };
    expect(json.token).toBe('minted-token');
    expect(json.userId).toBe(DEFAULT_BENCHMARK_USER_ID);
    expect(json.organizationId).toBe(DEFAULT_BENCHMARK_ORG_ID);
    expect(typeof json.expiresAt).toBe('string');
    expect(mockGenerateApiToken).toHaveBeenCalledWith(
      user,
      {
        tokenSource: 'mcp-catalog',
        organizationId: DEFAULT_BENCHMARK_ORG_ID,
        organizationRole: 'owner',
      },
      { expiresIn: 60 * 60 }
    );
  });

  // The mint must follow the benchmark worker's configured identity instead
  // of a hardcoded one.
  it('mints for the configured benchmark identity, not the contracts default', async () => {
    const userId = 'bot-internal-catalog';
    const organizationId = '9d278969-0000-0000-0000-000000000000';
    mockGetBenchmarkConfig.mockResolvedValue({
      status: 200,
      body: {
        config: {
          benchmarkUserId: userId,
          benchmarkOrgId: organizationId,
        },
      },
    });
    mockRows.push(eligibleAccount({ id: userId }));
    mockMembershipRows.push({ role: 'member' });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { userId: string; organizationId: string };
    expect(json.userId).toBe(userId);
    expect(json.organizationId).toBe(organizationId);
    expect(mockGenerateApiToken).toHaveBeenCalledWith(
      eligibleAccount({ id: userId }),
      {
        tokenSource: 'mcp-catalog',
        organizationId,
        organizationRole: 'member',
      },
      { expiresIn: 60 * 60 }
    );
  });

  it('refuses a configured identity that is not an internal bot', async () => {
    mockGetBenchmarkConfig.mockResolvedValue({
      status: 200,
      body: { config: { benchmarkUserId: 'human-user', benchmarkOrgId: null } },
    });
    mockRows.push({ id: 'human-user', api_token_pepper: 'pepper' });
    mockMembershipRows.push({ role: 'owner' });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining('is not an internal bot user'),
    });
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('falls back to the contracts defaults when the benchmark config is null', async () => {
    mockGetBenchmarkConfig.mockResolvedValue({ status: 200, body: { config: null } });
    mockRows.push(eligibleAccount());
    mockMembershipRows.push({ role: 'owner' });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { organizationId: string };
    expect(json.organizationId).toBe(DEFAULT_BENCHMARK_ORG_ID);
  });
});
