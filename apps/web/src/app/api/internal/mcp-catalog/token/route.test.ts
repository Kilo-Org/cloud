import { NextRequest } from 'next/server';
import { generateApiToken } from '@/lib/tokens';
import {
  DEFAULT_BENCHMARK_ORG_ID,
  DEFAULT_BENCHMARK_USER_ID,
} from '@kilocode/auto-routing-contracts';

jest.mock('@/lib/config.server', () => ({
  MCP_CATALOG_TOKEN_SECRET: 'catalog-secret',
}));

const mockRows: unknown[] = [];
const mockMembershipRows: unknown[] = [];
let mockSelectCallCount = 0;
jest.mock('@/lib/drizzle', () => ({
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

jest.mock('@/lib/tokens', () => ({
  generateApiToken: jest.fn(() => 'minted-token'),
}));

const mockGetBenchmarkConfig = jest.fn();
jest.mock('@/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
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
    mockRows.push({ id: DEFAULT_BENCHMARK_USER_ID, api_token_pepper: 'pepper' });
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

  it('mints a 1h benchmarking token scoped to the benchmark organization', async () => {
    const user = { id: DEFAULT_BENCHMARK_USER_ID, api_token_pepper: 'pepper' };
    mockRows.push(user);
    mockMembershipRows.push({ role: 'owner' });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      token: string;
      organizationId: string;
      expiresAt: string;
    };
    expect(json.token).toBe('minted-token');
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

  // Production configures a dedicated service account, so the default id in
  // the contracts package 404s. The mint must follow the benchmark worker's
  // configured identity instead of a hardcoded one.
  it('mints for the configured benchmark identity, not the contracts default', async () => {
    const userId = 'ce12ef3d-0000-0000-0000-000000000000';
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
    mockRows.push({ id: userId, api_token_pepper: 'pepper' });
    mockMembershipRows.push({ role: 'member' });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { organizationId: string };
    expect(json.organizationId).toBe(organizationId);
    expect(mockGenerateApiToken).toHaveBeenCalledWith(
      { id: userId, api_token_pepper: 'pepper' },
      {
        tokenSource: 'mcp-catalog',
        organizationId,
        organizationRole: 'member',
      },
      { expiresIn: 60 * 60 }
    );
  });

  it('falls back to the contracts defaults when the benchmark config is null', async () => {
    mockGetBenchmarkConfig.mockResolvedValue({ status: 200, body: { config: null } });
    mockRows.push({ id: DEFAULT_BENCHMARK_USER_ID, api_token_pepper: 'pepper' });
    mockMembershipRows.push({ role: 'owner' });

    const res = await POST(createRequest({ authorization: 'Bearer catalog-secret' }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { organizationId: string };
    expect(json.organizationId).toBe(DEFAULT_BENCHMARK_ORG_ID);
  });
});
