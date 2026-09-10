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

import { POST } from './route';

const mockGenerateApiToken = jest.mocked(generateApiToken);

function createRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/internal/mcp-catalog/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('POST /api/internal/mcp-catalog/token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.length = 0;
    mockMembershipRows.length = 0;
    mockSelectCallCount = 0;
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
});
