import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { generateVercelDownstreamSafetyIdentifier } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET, POST } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));

const originalOrg = process.env.OPENROUTER_ORG_ID;

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanupDbForTest();
  process.env.OPENROUTER_ORG_ID = 'synthetic-org';
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user: defineTestUser({ is_admin: true }),
    authFailedResponse: null,
  });
});

afterEach(() => {
  if (originalOrg === undefined) delete process.env.OPENROUTER_ORG_ID;
  else process.env.OPENROUTER_ORG_ID = originalOrg;
});

test.each([
  ['GET', GET],
  ['POST', POST],
])('%s requires admin authorization and leaves users untouched', async (_method, handler) => {
  const user = await insertTestUser();
  const denied = NextResponse.json(
    { success: false as const, error: 'Unauthorized' },
    { status: 403 }
  );
  jest.mocked(getUserFromAuth).mockResolvedValue({ user: null, authFailedResponse: denied });

  expect(await handler()).toBe(denied);
  expect(getUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
  const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
  expect(row.vercel_downstream_safety_identifier).toBeNull();
});

test('GET returns the number of users missing a safety identifier', async () => {
  await insertTestUser();
  await insertTestUser({ vercel_downstream_safety_identifier: 'existing-vercel-1' });
  await insertTestUser({
    openrouter_upstream_safety_identifier: 'existing-upstream-2',
    openrouter_downstream_safety_identifier: 'existing-downstream-2',
    vercel_downstream_safety_identifier: 'existing-vercel-2',
  });

  const response = await GET();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ missing: 2 });
});

test('POST backfills missing identifiers and returns the batch result', async () => {
  const user = await insertTestUser();

  const response = await POST();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ processed: 1, remaining: false });
  const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
  expect(row.vercel_downstream_safety_identifier).toBe(
    generateVercelDownstreamSafetyIdentifier(user.id)
  );
  await expect((await GET()).json()).resolves.toEqual({ missing: 0 });
});
