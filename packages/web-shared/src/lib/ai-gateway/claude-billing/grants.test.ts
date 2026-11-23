import { describe, expect, it, jest } from '@jest/globals';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  byok_api_keys,
  claude_billing_connection_grants,
  claude_billing_connections,
  organization_memberships,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  type ClaudeBillingShareError,
  ClaudeBillingLockBusyError,
  __test__,
  claudeBillingEffectiveConnection,
  claudeBillingOwnerLockKey,
  claudeBillingPayerLockKey,
  claudeBillingProfileLockKey,
  describeClaudeBillingSharing,
  getGrantedClaudeBillingConnection,
  insertClaudeBillingProfile,
  removeClaudeBillingGrant,
  removeUserClaudeBillingGrants,
  shareClaudeBillingConnection,
  type ClaudeBillingOwner,
} from './store';
import { claudeBillingOwnerMatches } from './owner';

/**
 * Holds one lock key in its own transaction and reports the backend pid that
 * holds it, so a concurrent operation can be observed queueing behind the key.
 * The caller releases `release` and then awaits the returned promise.
 */
async function holdLockKey(lockKey: string) {
  const lockHeld = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const holder = db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const backend = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
    const pid = backend.rows[0]?.pid;
    if (pid === undefined) throw new Error('PostgreSQL backend pid unavailable');
    lockHeld.resolve(pid);
    await release.promise;
  });
  return { holderPid: await lockHeld.promise, release: () => release.resolve(), holder };
}

/** Holds the payer key of one row, which is the key the module takes for that row. */
async function holdPayerKey(payerConnectionId: string) {
  return await holdLockKey(`claude_billing_grant:${payerConnectionId}`);
}

/**
 * Waits until some backend in this database is blocked by the holder. The wait is
 * bounded in database time, not by a wall-clock timer: each pass probes
 * `pg_stat_activity`, then a short database sleep when nothing was found.
 *
 * A blocked backend cannot finish, so an operation that settles without any
 * waiter proves the property false and fails here with the state named.
 */
async function waitForLockOf(holderPid: number, settled: () => boolean): Promise<void> {
  const nothingWaited = (state: string) =>
    new Error(`No backend waited for the lock held by pid ${holderPid}; the operation ${state}`);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await db.execute(sql`
      select 1
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and ${holderPid} = any(pg_blocking_pids(pid))`);
    if (waiting.rows.length > 0) return;
    if (settled()) throw nothingWaited('settled without blocking');
    await db.execute(sql`select pg_sleep(0.02)`);
  }
  throw nothingWaited(`had not settled after ${200} probes`);
}

async function connectedPayer(kiloUserId: string | null, organizationId: string | null = null) {
  const [row] = await db
    .insert(claude_billing_connections)
    .values({
      kilo_user_id: kiloUserId,
      organization_id: organizationId,
      user_profile_id: `uprof_${crypto.randomUUID()}`,
      connection_id: `ocon_${crypto.randomUUID()}`,
      status: 'connected',
      connected_at: new Date().toISOString(),
      created_by: kiloUserId ?? 'fixture',
    })
    .returning();
  if (!row) throw new Error('Missing payer fixture');
  return row;
}

async function activeGrants(payerConnectionId: string) {
  return await db
    .select()
    .from(claude_billing_connection_grants)
    .where(
      and(
        eq(claude_billing_connection_grants.payer_connection_id, payerConnectionId),
        isNull(claude_billing_connection_grants.removed_at)
      )
    );
}

describe('Claude billing grants', () => {
  it('shares one payer between a personal and an organization scope', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude grants', user.id, 0);
    const payer = await connectedPayer(user.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    await shareClaudeBillingConnection(personal, organizationOwner, user.id);

    await expect(
      Promise.all([
        getGrantedClaudeBillingConnection(personal),
        getGrantedClaudeBillingConnection(organizationOwner),
      ])
    ).resolves.toEqual([
      expect.objectContaining({ connection: expect.objectContaining({ id: payer.id }) }),
      expect.objectContaining({ connection: expect.objectContaining({ id: payer.id }) }),
    ]);
    await expect(activeGrants(payer.id)).resolves.toHaveLength(2);

    await removeClaudeBillingGrant(organizationOwner);

    await expect(
      Promise.all([
        getGrantedClaudeBillingConnection(organizationOwner),
        getGrantedClaudeBillingConnection(personal),
      ])
    ).resolves.toEqual([
      null,
      expect.objectContaining({ connection: expect.objectContaining({ id: payer.id }) }),
    ]);
  });

  it('shares an organization-first link back to personal and deletes only the personal Anthropic key', async () => {
    const user = await insertTestUser();
    const orgA = await createTestOrganization('Org First Alpha', user.id, 0);
    const orgB = await createTestOrganization('Org First Beta', user.id, 0);
    const [sharedFirstPayer] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: orgA.id,
        user_profile_id: `uprof_${crypto.randomUUID()}`,
        connection_id: `ocon_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: user.id,
      })
      .returning();
    if (!sharedFirstPayer) throw new Error('Missing shared-first payer fixture');
    await db.insert(byok_api_keys).values([
      {
        kilo_user_id: user.id,
        organization_id: null,
        provider_id: 'anthropic',
        created_by: user.id,
      },
      {
        kilo_user_id: null,
        organization_id: orgA.id,
        provider_id: 'anthropic',
        created_by: user.id,
      },
    ]);

    const sharedA: ClaudeBillingOwner = { kind: 'organization', organizationId: orgA.id };
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const sharedB: ClaudeBillingOwner = { kind: 'organization', organizationId: orgB.id };

    await shareClaudeBillingConnection(sharedA, personal, user.id);
    await shareClaudeBillingConnection(personal, sharedB, user.id);

    await expect(
      Promise.all([
        getGrantedClaudeBillingConnection(sharedA),
        getGrantedClaudeBillingConnection(personal),
        getGrantedClaudeBillingConnection(sharedB),
      ])
    ).resolves.toEqual([
      expect.objectContaining({ connection: expect.objectContaining({ id: sharedFirstPayer.id }) }),
      expect.objectContaining({ connection: expect.objectContaining({ id: sharedFirstPayer.id }) }),
      expect.objectContaining({ connection: expect.objectContaining({ id: sharedFirstPayer.id }) }),
    ]);

    const remainingKeys = await db
      .select()
      .from(byok_api_keys)
      .where(eq(byok_api_keys.created_by, user.id));
    expect(remainingKeys).toEqual([
      expect.objectContaining({ organization_id: orgA.id, kilo_user_id: null }),
    ]);
  });

  it('reassigns payer columns on initial-scope removal so the freed scope can link a second Claude account', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude multi account', user.id, 0);
    const firstPayer = await connectedPayer(user.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    await shareClaudeBillingConnection(personal, organizationOwner, user.id);
    await expect(removeClaudeBillingGrant(personal)).resolves.toBeNull();

    const secondProfile = await insertClaudeBillingProfile(
      personal,
      `uprof_second_${crypto.randomUUID()}`,
      user.id
    );
    await db
      .update(claude_billing_connections)
      .set({
        status: 'connected',
        connection_id: `ocon_${crypto.randomUUID()}`,
        connected_at: new Date().toISOString(),
      })
      .where(eq(claude_billing_connections.id, secondProfile.id));

    await expect(getGrantedClaudeBillingConnection(organizationOwner)).resolves.toMatchObject({
      connection: { id: firstPayer.id, status: 'connected' },
    });
    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toMatchObject({
      connection: { id: secondProfile.id, status: 'connected' },
    });

    const personalChoices = await describeClaudeBillingSharing(user.id, personal, true, null);
    expect(personalChoices.shareableLinks).toEqual([
      expect.objectContaining({
        payerId: firstPayer.id,
        label: 'Claude multi account',
        source: { organizationId: organization.id },
      }),
    ]);
  });

  it('prevents another organization admin from sharing the organization payer they did not link', async () => {
    const alice = await insertTestUser();
    const bob = await insertTestUser();
    const organization = await createTestOrganization('Claude admin boundary', alice.id, 0);
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: bob.id,
      role: 'admin',
    });
    const [alicePayer] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_${crypto.randomUUID()}`,
        connection_id: `ocon_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: alice.id,
      })
      .returning();
    if (!alicePayer) throw new Error('Missing Alice organization payer');

    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };
    const bobPersonal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: bob.id };

    await expect(
      shareClaudeBillingConnection(organizationOwner, bobPersonal, bob.id)
    ).rejects.toMatchObject({
      reason: 'source_forbidden',
    } satisfies Partial<ClaudeBillingShareError>);

    const bobSharing = await describeClaudeBillingSharing(bob.id, bobPersonal, true, null);
    expect(bobSharing.shareableLinks).toEqual([]);
  });

  it('refuses a share authorized only by a grant that names both a person and an organization', async () => {
    const alice = await insertTestUser();
    const bob = await insertTestUser();
    const organization = await createTestOrganization('Claude legacy member grant', alice.id, 0);
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: bob.id,
      role: 'admin',
    });
    // The connection belongs to the organization and records Alice as its
    // connector, so Bob must show a grant of his own to share it.
    const [payer] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_${crypto.randomUUID()}`,
        connection_id: `ocon_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: alice.id,
      })
      .returning();
    if (!payer) throw new Error('Missing Alice organization payer');
    await db.insert(claude_billing_connection_grants).values([
      {
        payer_connection_id: payer.id,
        kilo_user_id: null,
        organization_id: organization.id,
        created_by: alice.id,
      },
      {
        payer_connection_id: payer.id,
        kilo_user_id: bob.id,
        organization_id: organization.id,
        created_by: alice.id,
      },
    ]);
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };
    const bobPersonal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: bob.id };

    await expect(
      shareClaudeBillingConnection(organizationOwner, bobPersonal, bob.id)
    ).rejects.toMatchObject({
      reason: 'source_forbidden',
    } satisfies Partial<ClaudeBillingShareError>);
    await expect(getGrantedClaudeBillingConnection(bobPersonal)).resolves.toBeNull();
  });

  it('refuses to replace a scope that uses another payer', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude occupied', user.id, 0);
    const personalPayer = await connectedPayer(user.id);
    const organizationPayer = await connectedPayer(null, organization.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    await expect(
      shareClaudeBillingConnection(personal, organizationOwner, user.id)
    ).rejects.toMatchObject({
      reason: 'target_connected',
    } satisfies Partial<ClaudeBillingShareError>);
    await expect(getGrantedClaudeBillingConnection(organizationOwner)).resolves.toMatchObject({
      connection: { id: organizationPayer.id },
    });
    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toMatchObject({
      connection: { id: personalPayer.id },
    });
  });

  it('hands a payer only to a scope Kilo still offers', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude retired scope', user.id, 0);
    const payer = await connectedPayer(null, organization.id);
    await db.insert(claude_billing_connection_grants).values([
      {
        payer_connection_id: payer.id,
        kilo_user_id: user.id,
        organization_id: organization.id,
        created_by: user.id,
      },
      {
        payer_connection_id: payer.id,
        kilo_user_id: null,
        organization_id: organization.id,
        created_by: user.id,
      },
    ]);
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    await expect(removeClaudeBillingGrant(organizationOwner)).resolves.toEqual({
      id: payer.id,
      userProfileId: payer.user_profile_id,
    });
    await expect(getGrantedClaudeBillingConnection(organizationOwner)).resolves.toBeNull();
  });

  it('retires a pending target row that holds only a grant naming both a person and an organization', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude pending legacy grant', user.id, 0);
    const payer = await connectedPayer(user.id);
    const [pendingTarget] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_pending_${crypto.randomUUID()}`,
        // Synthetic: a Pending row that carries the retirement columns, so the
        // retirement write must clear them and not only flip the status.
        connection_id: `ocon_${crypto.randomUUID()}`,
        connected_at: new Date().toISOString(),
        last_refusal_code: 'linked_organization_spend_limit_reached',
        last_refusal_at: new Date().toISOString(),
        status: 'pending',
        created_by: user.id,
      })
      .returning();
    if (!pendingTarget) throw new Error('Missing pending target fixture');
    await db.insert(claude_billing_connection_grants).values([
      // The organization's own grant, which the share moves to the payer it
      // shares, so only the retired member grant is left on the pending row.
      {
        payer_connection_id: pendingTarget.id,
        kilo_user_id: null,
        organization_id: organization.id,
        created_by: user.id,
      },
      {
        payer_connection_id: pendingTarget.id,
        kilo_user_id: user.id,
        organization_id: organization.id,
        created_by: user.id,
      },
    ]);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    await shareClaudeBillingConnection(personal, organizationOwner, user.id);

    await expect(getGrantedClaudeBillingConnection(organizationOwner)).resolves.toMatchObject({
      connection: { id: payer.id },
    });
    await expect(
      db
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.id, pendingTarget.id))
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'removed',
        connection_id: null,
        connected_at: null,
        last_refusal_code: null,
        last_refusal_at: null,
      }),
    ]);
  });

  it('retires a pending target row with the full retirement column set when sharing over it', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude pending target', user.id, 0);
    const payer = await connectedPayer(user.id);
    const [pendingTarget] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_pending_${crypto.randomUUID()}`,
        // Synthetic: a Pending row that somehow carries the retirement columns.
        // The retirement write must clear them, not only flip the status.
        connection_id: `ocon_${crypto.randomUUID()}`,
        connected_at: new Date().toISOString(),
        last_refusal_code: 'linked_organization_spend_limit_reached',
        last_refusal_at: new Date().toISOString(),
        status: 'pending',
        created_by: user.id,
      })
      .returning();
    if (!pendingTarget) throw new Error('Missing pending target fixture');
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    await shareClaudeBillingConnection(personal, organizationOwner, user.id);

    await expect(getGrantedClaudeBillingConnection(organizationOwner)).resolves.toMatchObject({
      connection: { id: payer.id },
    });
    await expect(
      db
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.id, pendingTarget.id))
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'removed',
        connection_id: null,
        connected_at: null,
        last_refusal_code: null,
        last_refusal_at: null,
      }),
    ]);
  });

  it('preserves a removed target profile row across grant removal and user erasure', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude preserved removed', user.id, 0);
    const [removedTarget] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_old_${crypto.randomUUID()}`,
        status: 'removed',
        created_by: user.id,
      })
      .returning();
    if (!removedTarget) throw new Error('Missing removed target fixture');
    const payer = await connectedPayer(user.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    await shareClaudeBillingConnection(personal, organizationOwner, user.id);
    await removeClaudeBillingGrant(personal);
    await expect(getGrantedClaudeBillingConnection(organizationOwner)).resolves.toMatchObject({
      connection: {
        id: payer.id,
        kilo_user_id: null,
        organization_id: organization.id,
      },
    });

    await removeUserClaudeBillingGrants(user.id, db);
    await expect(getGrantedClaudeBillingConnection(organizationOwner)).resolves.toMatchObject({
      connection: {
        id: payer.id,
        kilo_user_id: null,
        organization_id: organization.id,
      },
    });
    const retainedOldRows = await db
      .select()
      .from(claude_billing_connections)
      .where(eq(claude_billing_connections.id, removedTarget.id));
    expect(retainedOldRows).toHaveLength(1);
  });

  it('keeps the connector on the payer row apart from the person who wrote the grant', async () => {
    const alice = await insertTestUser();
    const bob = await insertTestUser();
    const organization = await createTestOrganization('Claude grant audit', alice.id, 0);
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: bob.id,
      role: 'admin',
    });
    const payer = await connectedPayer(alice.id);
    await db.insert(claude_billing_connection_grants).values({
      payer_connection_id: payer.id,
      kilo_user_id: null,
      organization_id: organization.id,
      created_by: bob.id,
    });
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    const granted = await getGrantedClaudeBillingConnection(organizationOwner);
    expect(granted).toMatchObject({
      connection: { id: payer.id, created_by: alice.id, kilo_user_id: alice.id },
      grant: { created_by: bob.id, kilo_user_id: null, organization_id: organization.id },
    });
    if (!granted) throw new Error('Missing resolved grant fixture');
    expect(claudeBillingOwnerMatches(granted.connection, organizationOwner)).toBe(false);
    expect(claudeBillingEffectiveConnection(granted)).toMatchObject({
      id: payer.id,
      kilo_user_id: null,
      organization_id: organization.id,
      created_by: bob.id,
    });
  });

  it('waits for the pending target payer lock before it retires the pending row', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude share lock', user.id, 0);
    const payer = await connectedPayer(user.id);
    const [pendingTarget] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_pending_${crypto.randomUUID()}`,
        // Synthetic: a Pending row that carries the retirement columns, so the
        // retirement write must clear them and not only flip the status.
        connection_id: `ocon_${crypto.randomUUID()}`,
        connected_at: new Date().toISOString(),
        last_refusal_code: 'linked_organization_spend_limit_reached',
        last_refusal_at: new Date().toISOString(),
        status: 'pending',
        created_by: user.id,
      })
      .returning();
    if (!pendingTarget) throw new Error('Missing pending target fixture');
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    const held = await holdPayerKey(pendingTarget.id);
    let settled = false;
    const share = shareClaudeBillingConnection(personal, organizationOwner, user.id).finally(() => {
      settled = true;
    });
    try {
      await waitForLockOf(held.holderPid, () => settled);
    } finally {
      held.release();
      await held.holder;
    }

    await expect(share).resolves.toMatchObject({ id: payer.id });
    await expect(getGrantedClaudeBillingConnection(organizationOwner)).resolves.toMatchObject({
      connection: { id: payer.id },
    });
    await expect(
      db
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.id, pendingTarget.id))
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'removed',
        connection_id: null,
        connected_at: null,
        last_refusal_code: null,
        last_refusal_at: null,
      }),
    ]);
  }, 20000);

  it('waits for the occupant payer lock before it frees the owner columns', async () => {
    const user = await insertTestUser();
    const occupant = await connectedPayer(user.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const nextProfileId = `uprof_second_${crypto.randomUUID()}`;

    const held = await holdPayerKey(occupant.id);
    let settled = false;
    const inserted = insertClaudeBillingProfile(personal, nextProfileId, user.id).finally(() => {
      settled = true;
    });
    try {
      await waitForLockOf(held.holderPid, () => settled);
    } finally {
      held.release();
      await held.holder;
    }

    await expect(inserted).resolves.toMatchObject({ user_profile_id: nextProfileId });
    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toMatchObject({
      connection: { user_profile_id: nextProfileId },
    });
    await expect(
      db
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.id, occupant.id))
    ).resolves.toEqual([expect.objectContaining({ status: 'removed', connection_id: null })]);
  }, 20000);

  it('frees an occupant payer below the removed payer through the public removal path', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization('Claude lower occupant', owner.id, 0);
    // The organization keeps a row from the release before grant persistence, so
    // its row records the owner but no grant points at it. These two ids make the
    // occupant sort below the shared payer, which is the ordering under test.
    const [occupantPayer] = await db
      .insert(claude_billing_connections)
      .values({
        id: '11111111-1111-4111-8111-111111111111',
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_occupant_${crypto.randomUUID()}`,
        connection_id: `ocon_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: owner.id,
      })
      .returning();
    if (!occupantPayer) throw new Error('Missing occupant payer fixture');
    const [sharedPayer] = await db
      .insert(claude_billing_connections)
      .values({
        id: 'ffffffff-ffff-4fff-bfff-fffffffffff1',
        kilo_user_id: owner.id,
        organization_id: null,
        user_profile_id: `uprof_shared_${crypto.randomUUID()}`,
        connection_id: `ocon_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: owner.id,
      })
      .returning();
    if (!sharedPayer) throw new Error('Missing shared payer fixture');
    await db.insert(claude_billing_connection_grants).values([
      {
        payer_connection_id: sharedPayer.id,
        kilo_user_id: owner.id,
        organization_id: null,
        created_by: owner.id,
      },
      {
        payer_connection_id: sharedPayer.id,
        kilo_user_id: null,
        organization_id: organization.id,
        created_by: owner.id,
      },
    ]);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: owner.id };

    // The removal hands the shared payer to the organization, which has to retire
    // its own occupant first. The occupant key sorts below the held payer key, so
    // the retry must restart and take both keys in ascending order instead of
    // deadlocking.
    await expect(removeClaudeBillingGrant(personal)).resolves.toBeNull();

    await expect(
      db
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.id, sharedPayer.id))
    ).resolves.toEqual([
      expect.objectContaining({
        kilo_user_id: null,
        organization_id: organization.id,
        status: 'connected',
      }),
    ]);
    await expect(
      db
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.id, occupantPayer.id))
    ).resolves.toEqual([expect.objectContaining({ status: 'removed', connection_id: null })]);
    await expect(activeGrants(occupantPayer.id)).resolves.toEqual([]);
  }, 20000);

  it('holds a claim key on the target scope while it shares, so two first shares into one scope cannot both report success', async () => {
    const user = await insertTestUser();
    // The organization has no payer row and no grant, so a share into it writes
    // the first grant on a scope that holds nothing yet.
    const organization = await createTestOrganization('Claude first share claim', user.id, 0);
    const payer = await connectedPayer(user.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const organizationOwner: ClaudeBillingOwner = {
      kind: 'organization',
      organizationId: organization.id,
    };

    const held = await holdLockKey(claudeBillingOwnerLockKey(organizationOwner));
    let settled = false;
    const share = shareClaudeBillingConnection(personal, organizationOwner, user.id).finally(() => {
      settled = true;
    });
    try {
      await waitForLockOf(held.holderPid, () => settled);
    } finally {
      held.release();
      await held.holder;
    }

    await expect(share).resolves.toMatchObject({ id: payer.id });
    await expect(
      db
        .select()
        .from(claude_billing_connection_grants)
        .where(
          and(
            eq(claude_billing_connection_grants.organization_id, organization.id),
            isNull(claude_billing_connection_grants.kilo_user_id),
            isNull(claude_billing_connection_grants.removed_at)
          )
        )
    ).resolves.toEqual([expect.objectContaining({ payer_connection_id: payer.id })]);
  }, 20000);

  it('restarts once per lower payer key it discovers, so a removal that frees several occupants still succeeds', async () => {
    const user = await insertTestUser();
    // Four payers this person owns, each kept by an organization grant, so the
    // removal hands every payer to its organization and frees that organization's
    // occupant row first. Each occupant id sorts below every payer key taken so
    // far, so each restart discovers one more occupant below the held keys. Every
    // restart adds that key, so the fourth attempt to meet one still makes
    // progress and the removal finishes.
    const fixtures = [
      {
        payerId: '44444444-4444-4444-8444-444444444401',
        occupantId: '33333333-3333-4333-8333-333333333301',
      },
      {
        payerId: '55555555-5555-4555-8555-555555555501',
        occupantId: '22222222-2222-4222-8222-222222222201',
      },
      {
        payerId: '66666666-6666-4666-8666-666666666601',
        occupantId: '11111111-1111-4111-8111-111111111101',
      },
      {
        payerId: '77777777-7777-4777-8777-777777777701',
        occupantId: '00000000-0000-4000-8000-000000000001',
      },
    ];
    const organizations: string[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const organization = await createTestOrganization(`Claude busy org ${index}`, user.id, 0);
      organizations.push(organization.id);
      // A payer row naming both the person and the organization is the shape the
      // retired member scope wrote; the organization grant then outlives the
      // person's own grant and becomes the payer's next owner.
      await db.insert(claude_billing_connections).values({
        id: fixture.payerId,
        kilo_user_id: user.id,
        organization_id: organization.id,
        user_profile_id: `uprof_busy_${index}_${crypto.randomUUID()}`,
        connection_id: `ocon_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: user.id,
      });
      await db.insert(claude_billing_connection_grants).values({
        payer_connection_id: fixture.payerId,
        kilo_user_id: null,
        organization_id: organization.id,
        created_by: user.id,
      });
      await db.insert(claude_billing_connections).values({
        id: fixture.occupantId,
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_occupant_${index}_${crypto.randomUUID()}`,
        connection_id: `ocon_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: user.id,
      });
    }
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(removeUserClaudeBillingGrants(user.id, db)).resolves.toBeUndefined();
    // No restart ran out of progress, so the busy path never ran.
    expect(warn.mock.calls).toEqual([]);
    warn.mockRestore();

    for (const [index, fixture] of fixtures.entries()) {
      const organizationId = organizations[index];
      if (!organizationId) throw new Error('Missing organization fixture');
      await expect(
        db
          .select()
          .from(claude_billing_connections)
          .where(eq(claude_billing_connections.id, fixture.payerId))
      ).resolves.toEqual([
        expect.objectContaining({
          kilo_user_id: null,
          organization_id: organizationId,
          status: 'connected',
        }),
      ]);
      await expect(
        db
          .select()
          .from(claude_billing_connections)
          .where(eq(claude_billing_connections.id, fixture.occupantId))
      ).resolves.toEqual([expect.objectContaining({ status: 'removed', connection_id: null })]);
    }
  }, 30000);

  it('answers a repeated lock key with ClaudeBillingLockBusyError after one warning', async () => {
    // A repeated key is unreachable through the public API: every caller checks
    // whether it already holds the key before it asks for a restart, so the store
    // never retries one it collected. That makes this the smallest honest proof of
    // the no-progress branch, driven through the retry loop itself.
    const { withClaudeBillingLockRetry, lockRetrySignal } = __test__;
    const repeatedKey = 'claude_billing_grant:00000000-0000-4000-8000-0000000000ff';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const attempts: string[][] = [];

    const failure = await withClaudeBillingLockRetry(async extraLockKeys => {
      attempts.push([...extraLockKeys]);
      throw lockRetrySignal(repeatedKey);
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClaudeBillingLockBusyError);
    if (!(failure instanceof ClaudeBillingLockBusyError)) {
      throw new Error('The retry loop did not reject with ClaudeBillingLockBusyError');
    }
    // The key was collected by one restart; the next one cannot change the order.
    expect(attempts).toEqual([[], [repeatedKey]]);
    expect(warn.mock.calls).toEqual([
      [
        '[claude-billing] lock retry cannot make progress: %s namespace after %d restarts',
        'grant',
        1,
      ],
    ]);
    // The key carries a payer connection id, so the log reports the namespace only.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('00000000-0000-4000-8000-0000000000ff');
    expect(logged).not.toContain('claude_billing_');
    warn.mockRestore();
    expect(failure.lockKey).toBe(repeatedKey);
    expect(failure.message).toBe('Claude billing locks stayed busy; retry the request');
    // The restart signal stays private: its sentence never reaches a caller.
    expect(failure.message).not.toContain('ascending key order');
  });

  it('takes the claim namespace below the payer namespace, and keeps the profile key outside that order', () => {
    const owner: ClaudeBillingOwner = { kind: 'organization', organizationId: 'scope-order' };
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: 'scope-order' };
    const payerId = 'scope-order';

    for (const scope of [owner, personal]) {
      const claimKey = claudeBillingOwnerLockKey(scope);
      const payerKey = claudeBillingPayerLockKey(payerId);
      const profileKey = claudeBillingProfileLockKey(scope);
      expect(claimKey.startsWith('claude_billing_claim:')).toBe(true);
      expect(payerKey.startsWith('claude_billing_grant:')).toBe(true);
      // The module's ascending order covers the claim and payer namespaces only.
      expect(claimKey < payerKey).toBe(true);
      // The profile key is not part of that order: it sorts last, and the only
      // safe use is a transaction that takes it before any claim or payer key and
      // that no other holder waits on. A different namespace keeps it out.
      expect(profileKey.startsWith('claude_billing_profile:')).toBe(true);
      expect(payerKey < profileKey).toBe(true);
    }
  });
});
