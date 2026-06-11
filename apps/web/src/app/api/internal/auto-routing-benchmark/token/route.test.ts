import { NextRequest } from 'next/server';
import { generateApiToken } from '@/lib/tokens';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-secret',
}));

// Chainable drizzle query builder mock. `.limit()` resolves to the rows we set.
const mockRows: unknown[] = [];
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockRows),
        }),
      }),
    }),
  },
}));

jest.mock('@/lib/tokens', () => ({
  generateApiToken: jest.fn(() => 'minted-token'),
}));

import { POST } from './route';

const mockGenerateApiToken = jest.mocked(generateApiToken);

function createRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/internal/auto-routing-benchmark/token', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('POST /api/internal/auto-routing-benchmark/token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.length = 0;
  });

  it('returns 401 without the bearer secret', async () => {
    mockRows.push({ id: 'user-1', api_token_pepper: 'pepper' });
    const res = await POST(createRequest({ userId: 'user-1' }));
    expect(res.status).toBe(401);
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('returns 401 with the wrong bearer secret', async () => {
    const res = await POST(createRequest({ userId: 'user-1' }, { authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid body', async () => {
    const res = await POST(createRequest({}, { authorization: 'Bearer internal-secret' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the user does not exist', async () => {
    const res = await POST(
      createRequest({ userId: 'missing' }, { authorization: 'Bearer internal-secret' })
    );
    expect(res.status).toBe(404);
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('mints a 6h token for an existing user', async () => {
    const user = { id: 'user-1', api_token_pepper: 'pepper' };
    mockRows.push(user);
    const res = await POST(
      createRequest({ userId: 'user-1' }, { authorization: 'Bearer internal-secret' })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { token: string; expiresAt: string };
    expect(json.token).toBe('minted-token');
    expect(typeof json.expiresAt).toBe('string');
    expect(mockGenerateApiToken).toHaveBeenCalledWith(
      user,
      { tokenSource: 'auto-routing-benchmark' },
      {
        expiresIn: 6 * 60 * 60,
      }
    );
  });
});
