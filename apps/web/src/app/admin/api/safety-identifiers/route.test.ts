import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import {
  generateOpenRouterDownstreamSafetyIdentifier,
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET, POST } from './route';

jest.mock('@kilocode/web-shared/lib/user/server');

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

function postBackfill(body?: unknown) {
  return POST(
    new NextRequest('http://localhost:3000/admin/api/safety-identifiers', {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    })
  );
}

function selectIdentifiers(id: string) {
  return db
    .select({
      openrouter_upstream_safety_identifier: kilocode_users.openrouter_upstream_safety_identifier,
      openrouter_downstream_safety_identifier:
        kilocode_users.openrouter_downstream_safety_identifier,
      vercel_downstream_safety_identifier: kilocode_users.vercel_downstream_safety_identifier,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, id));
}

function staleIdentifiers(tag: string) {
  return {
    openrouter_upstream_safety_identifier: `stale-openrouter-upstream-${tag}`,
    openrouter_downstream_safety_identifier: `stale-openrouter-downstream-${tag}`,
    vercel_downstream_safety_identifier: `stale-vercel-downstream-${tag}`,
  };
}

describe('safety identifier backfill', () => {
  it('fills the OpenRouter downstream identifier without replacing existing identifiers', async () => {
    const user = await insertTestUser({
      openrouter_upstream_safety_identifier: 'existing-openrouter-upstream',
      vercel_downstream_safety_identifier: 'existing-vercel-downstream',
    });

    const countResponse = await GET();
    expect(await countResponse.json()).toEqual({ missing: 1 });

    const backfillResponse = await postBackfill();
    expect(await backfillResponse.json()).toEqual({ processed: 1, remaining: false });

    const [updatedUser] = await selectIdentifiers(user.id);

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

  it('recomputes every stored identifier from the key in force', async () => {
    const user = await insertTestUser(staleIdentifiers('recompute'));

    const countResponse = await GET();
    expect(await countResponse.json()).toEqual({ missing: 0 });

    const response = await postBackfill({ mode: 'recompute' });
    expect(await response.json()).toEqual({ processed: 1, remaining: false });

    const [updatedUser] = await selectIdentifiers(user.id);
    expect(updatedUser).toEqual({
      openrouter_upstream_safety_identifier: generateOpenRouterUpstreamSafetyIdentifier(user.id),
      openrouter_downstream_safety_identifier: generateOpenRouterDownstreamSafetyIdentifier(
        user.id
      ),
      vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(user.id),
    });
  });

  it('resumes a recompute after the returned cursor instead of restarting it', async () => {
    const users = [
      { user: await insertTestUser(staleIdentifiers('first')), tag: 'first' },
      { user: await insertTestUser(staleIdentifiers('second')), tag: 'second' },
    ];
    const descending = [...users].sort((a, b) => (a.user.id < b.user.id ? 1 : -1));
    const alreadyProcessed = descending[0];
    const pending = descending[1];

    const response = await postBackfill({ mode: 'recompute', cursor: alreadyProcessed.user.id });
    expect(await response.json()).toEqual({ processed: 1, remaining: false });

    expect(await selectIdentifiers(alreadyProcessed.user.id)).toEqual([
      staleIdentifiers(alreadyProcessed.tag),
    ]);
    expect(await selectIdentifiers(pending.user.id)).toEqual([
      {
        openrouter_upstream_safety_identifier: generateOpenRouterUpstreamSafetyIdentifier(
          pending.user.id
        ),
        openrouter_downstream_safety_identifier: generateOpenRouterDownstreamSafetyIdentifier(
          pending.user.id
        ),
        vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(
          pending.user.id
        ),
      },
    ]);
  });

  it('rejects an unknown mode without touching identifiers', async () => {
    const user = await insertTestUser({
      openrouter_upstream_safety_identifier: 'existing-openrouter-upstream',
    });

    const response = await postBackfill({ mode: 'everything' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });

    const [unchangedUser] = await selectIdentifiers(user.id);
    expect(unchangedUser).toEqual({
      openrouter_upstream_safety_identifier: 'existing-openrouter-upstream',
      openrouter_downstream_safety_identifier: null,
      vercel_downstream_safety_identifier: null,
    });
  });
});
