import { db } from '@/lib/drizzle';
import { generateApiToken } from '@/lib/tokens';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

let mockRequestHeaders = new Headers();

jest.mock('next/headers', () => ({
  headers: jest.fn(async () => mockRequestHeaders),
  cookies: jest.fn(async () => ({
    get: jest.fn(),
    getAll: jest.fn(() => []),
    set: jest.fn(),
  })),
}));

describe('Cloud tRPC route bearer authentication', () => {
  it('serves existing procedures through the existing /api/trpc transport', async () => {
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const token = generateApiToken(user);
    mockRequestHeaders = new Headers({ Authorization: `Bearer ${token}` });
    const { GET } = await import('./route');

    const response = await GET(
      new Request('http://localhost/api/trpc/user.getAutoTopUpPaymentMethod', {
        headers: mockRequestHeaders,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      result: {
        data: {
          enabled: false,
          amountCents: 5000,
          thresholdCents: 500,
          configured: false,
          paymentMethod: null,
        },
      },
    });

    await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
  });
});
