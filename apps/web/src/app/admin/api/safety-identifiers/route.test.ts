import { getUserFromAuth } from '@/lib/user/server';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import { generateOpenRouterDownstreamSafetyIdentifier } from '@/lib/ai-gateway/providerHash';
import { defineTestUser, insertTestUser } from '@/tests/helpers/user.helper';
import { GET, POST } from './route';

jest.mock('@/lib/user/server');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const originalOpenRouterOrgId = process.env.OPENROUTER_ORG_ID;

beforeEach(async () => {
  await cleanupDbForTest();
  process.env.OPENROUTER_ORG_ID = 'test-openrouter-org';
  mockedGetUserFromAuth.mockResolvedValue({
    user: defineTestUser({ is_admin: true }),
    authFailedResponse: null,
  });
});

afterEach(() => {
  if (originalOpenRouterOrgId === undefined) {
    delete process.env.OPENROUTER_ORG_ID;
  } else {
    process.env.OPENROUTER_ORG_ID = originalOpenRouterOrgId;
  }
});

describe('safety identifier backfill', () => {
  it('fills the OpenRouter downstream identifier without replacing existing identifiers', async () => {
    const user = await insertTestUser({
      openrouter_upstream_safety_identifier: 'existing-openrouter-upstream',
      vercel_downstream_safety_identifier: 'existing-vercel-downstream',
    });

    const countResponse = await GET();
    expect(await countResponse.json()).toEqual({ missing: 1 });

    const backfillResponse = await POST();
    expect(await backfillResponse.json()).toEqual({ processed: 1, remaining: false });

    const [updatedUser] = await db
      .select({
        openrouter_upstream_safety_identifier: kilocode_users.openrouter_upstream_safety_identifier,
        openrouter_downstream_safety_identifier:
          kilocode_users.openrouter_downstream_safety_identifier,
        vercel_downstream_safety_identifier: kilocode_users.vercel_downstream_safety_identifier,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));

    expect(updatedUser).toEqual({
      openrouter_upstream_safety_identifier: 'existing-openrouter-upstream',
      openrouter_downstream_safety_identifier: generateOpenRouterDownstreamSafetyIdentifier(
        user.id
      ),
      vercel_downstream_safety_identifier: 'existing-vercel-downstream',
    });

    const completeCountResponse = await GET();
    expect(await completeCountResponse.json()).toEqual({ missing: 0 });
  });
});
