import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  generateOpenRouterDownstreamSafetyIdentifier,
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  backfillSafetyIdentifiersBatch,
  countMissingSafetyIdentifiers,
} from './safety-identifiers';

const originalOrg = process.env.OPENROUTER_ORG_ID;
const updatedAt = '2025-01-01T00:00:00.000Z';

async function selectUser(id: string) {
  const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, id));
  return row;
}

function expectedIdentifiers(id: string) {
  return {
    openrouter_upstream_safety_identifier: generateOpenRouterUpstreamSafetyIdentifier(id),
    openrouter_downstream_safety_identifier: generateOpenRouterDownstreamSafetyIdentifier(id),
    vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(id),
  };
}

beforeEach(async () => {
  await cleanupDbForTest();
  process.env.OPENROUTER_ORG_ID = 'synthetic-org';
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalOrg === undefined) delete process.env.OPENROUTER_ORG_ID;
  else process.env.OPENROUTER_ORG_ID = originalOrg;
});

describe('countMissingSafetyIdentifiers', () => {
  it('counts users missing any of the three identifiers', async () => {
    await insertTestUser();
    await insertTestUser({ openrouter_upstream_safety_identifier: 'existing-upstream-1' });
    await insertTestUser({
      openrouter_upstream_safety_identifier: 'existing-upstream-2',
      openrouter_downstream_safety_identifier: 'existing-downstream-2',
    });
    await insertTestUser({
      openrouter_upstream_safety_identifier: 'existing-upstream-3',
      openrouter_downstream_safety_identifier: 'existing-downstream-3',
      vercel_downstream_safety_identifier: 'existing-vercel-3',
    });

    await expect(countMissingSafetyIdentifiers()).resolves.toBe(3);
  });

  it('returns zero for an empty table', async () => {
    await expect(countMissingSafetyIdentifiers()).resolves.toBe(0);
  });
});

describe('backfillSafetyIdentifiersBatch', () => {
  it('fills missing identifiers with generated values and preserves updated_at', async () => {
    const users = await Promise.all([
      insertTestUser({ updated_at: updatedAt }),
      insertTestUser({ id: 'oauth/synthetic-provider/account', updated_at: updatedAt }),
    ]);

    await expect(backfillSafetyIdentifiersBatch()).resolves.toEqual({
      processed: 2,
      remaining: false,
    });

    for (const user of users) {
      const row = await selectUser(user.id);
      expect(row).toMatchObject(expectedIdentifiers(user.id));
      expect(new Date(row.updated_at).toISOString()).toBe(updatedAt);
    }
    await expect(countMissingSafetyIdentifiers()).resolves.toBe(0);
  });

  it('keeps existing identifiers on partially filled rows', async () => {
    const upstreamOnly = await insertTestUser({
      updated_at: updatedAt,
      openrouter_upstream_safety_identifier: 'existing-upstream',
    });
    const missingVercel = await insertTestUser({
      updated_at: updatedAt,
      openrouter_upstream_safety_identifier: 'existing-upstream-2',
      openrouter_downstream_safety_identifier: 'existing-downstream-2',
    });

    await expect(backfillSafetyIdentifiersBatch()).resolves.toEqual({
      processed: 2,
      remaining: false,
    });

    const upstreamOnlyRow = await selectUser(upstreamOnly.id);
    expect(upstreamOnlyRow).toMatchObject({
      openrouter_upstream_safety_identifier: 'existing-upstream',
      openrouter_downstream_safety_identifier: generateOpenRouterDownstreamSafetyIdentifier(
        upstreamOnly.id
      ),
      vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(
        upstreamOnly.id
      ),
    });
    expect(new Date(upstreamOnlyRow.updated_at).toISOString()).toBe(updatedAt);

    expect(await selectUser(missingVercel.id)).toMatchObject({
      openrouter_upstream_safety_identifier: 'existing-upstream-2',
      openrouter_downstream_safety_identifier: 'existing-downstream-2',
      vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(
        missingVercel.id
      ),
    });
  });

  it('leaves fully filled rows untouched and reports nothing remaining', async () => {
    const filled = await insertTestUser({
      updated_at: updatedAt,
      openrouter_upstream_safety_identifier: 'existing-upstream',
      openrouter_downstream_safety_identifier: 'existing-downstream',
      vercel_downstream_safety_identifier: 'existing-vercel',
    });

    await expect(backfillSafetyIdentifiersBatch()).resolves.toEqual({
      processed: 0,
      remaining: false,
    });
    expect(await selectUser(filled.id)).toMatchObject({
      openrouter_upstream_safety_identifier: 'existing-upstream',
      openrouter_downstream_safety_identifier: 'existing-downstream',
      vercel_downstream_safety_identifier: 'existing-vercel',
    });
  });

  it.each([undefined, ''])('throws without writing when OPENROUTER_ORG_ID is %p', async org => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    if (org === undefined) delete process.env.OPENROUTER_ORG_ID;
    else process.env.OPENROUTER_ORG_ID = org;
    const user = await insertTestUser();

    await expect(backfillSafetyIdentifiersBatch()).rejects.toThrow(
      'OPENROUTER_ORG_ID is not configured'
    );
    expect(await selectUser(user.id)).toMatchObject({
      openrouter_upstream_safety_identifier: null,
      openrouter_downstream_safety_identifier: null,
      vercel_downstream_safety_identifier: null,
    });
  });
});
