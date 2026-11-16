jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/operator', () => ({
  getClaudeOperatorToken: jest.fn(async () => 'local-test-token'),
  isClaudeOperatorConfigured: jest.fn(() => true),
  unlinkClaudeUserProfile: jest.fn(async () => ({ kind: 'unlinked', revokedConnectionIds: [] })),
}));

import { afterEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { claude_billing_connection_grants, claude_billing_connections } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  getClaudeBillingConnection,
  removeClaudeBillingGrant,
  shareClaudeBillingConnection,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import {
  ClaudeProfileDeletionError,
  cleanupRemovedClaudeProfilesForUser,
  deleteUserClaudeProfiles,
  retireUnreferencedClaudeBillingPayer,
} from './delete';

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(isClaudeOperatorConfigured).mockReturnValue(true);
  jest
    .mocked(unlinkClaudeUserProfile)
    .mockReset()
    .mockResolvedValue({ kind: 'unlinked', revokedConnectionIds: [] });
});

async function connectedUser() {
  const user = await insertTestUser();
  await db.insert(claude_billing_connections).values({
    kilo_user_id: user.id,
    user_profile_id: `uprof_${user.id}`,
    created_by: user.id,
    status: 'connected',
    connected_at: new Date().toISOString(),
  });
  return user;
}

describe('Personal Claude profile erasure', () => {
  it('does not call the provider when no personal profile exists', async () => {
    const user = await insertTestUser();
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    await deleteUserClaudeProfiles(user.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a payer the organization still uses', async () => {
    const user = await connectedUser();
    const organization = await createTestOrganization('Claude shared erasure', user.id, 0);
    await shareClaudeBillingConnection(
      { kind: 'personal', kiloUserId: user.id },
      { kind: 'organization', organizationId: organization.id },
      user.id
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    await deleteUserClaudeProfiles(user.id);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ status: 'connected' });
  });

  it('deletes the profile after both the personal grant and the organization grant are removed', async () => {
    const user = await connectedUser();
    const organization = await createTestOrganization('Claude full removal erasure', user.id, 0);
    const personal = { kind: 'personal' as const, kiloUserId: user.id };
    const shared = { kind: 'organization' as const, organizationId: organization.id };
    await shareClaudeBillingConnection(personal, shared, user.id);
    await removeClaudeBillingGrant(personal);
    await removeClaudeBillingGrant(shared);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    await deleteUserClaudeProfiles(user.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`uprof_${user.id}`);
    expect(await getClaudeBillingConnection(personal)).toBeNull();
  });

  it('deletes a removed organization row created by the user instead of marking it billing_unavailable', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude removed shared erasure', user.id, 0);
    await db.insert(claude_billing_connections).values({
      kilo_user_id: null,
      organization_id: organization.id,
      user_profile_id: `uprof_removed_shared_${user.id}`,
      status: 'removed',
      created_by: user.id,
    });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    await deleteUserClaudeProfiles(user.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`uprof_removed_shared_${user.id}`);
    expect(
      await getClaudeBillingConnection({ kind: 'organization', organizationId: organization.id })
    ).toBeNull();
  });

  it.each([200, 404])('accepts deletion or authoritative absence (%s)', async status => {
    const user = await connectedUser();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status })
      );
    await deleteUserClaudeProfiles(user.id);
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ user_profile_id: `uprof_${user.id}`, status: 'billing_unavailable' });
  });

  it("deletes the profiles of the person's own rows, including a row a retired scope wrote, and keeps the organization's one", async () => {
    const user = await connectedUser();
    const organization = await createTestOrganization('Claude erasure', user.id, 0);
    await db.insert(claude_billing_connections).values([
      {
        kilo_user_id: user.id,
        organization_id: organization.id,
        user_profile_id: `uprof_member_${user.id}`,
        created_by: user.id,
        status: 'connected',
      },
      {
        organization_id: organization.id,
        user_profile_id: `uprof_shared_${user.id}`,
        created_by: user.id,
        status: 'connected',
      },
    ]);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );
    await deleteUserClaudeProfiles(user.id);
    const deleted = fetchMock.mock.calls.map(([url]) => String(url).split('/').at(-1));
    expect(deleted.sort()).toEqual([`uprof_${user.id}`, `uprof_member_${user.id}`].sort());
    expect(
      await getClaudeBillingConnection({ kind: 'organization', organizationId: organization.id })
    ).toMatchObject({ status: 'connected' });
  });

  it.each([
    [503, true],
    [408, true],
    [425, true],
    [403, false],
  ] as const)(
    'keeps the profile identifier when deletion fails (%s)',
    async (status, retryable) => {
      const user = await connectedUser();
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));
      await expect(deleteUserClaudeProfiles(user.id)).rejects.toMatchObject({ retryable });
      expect(
        await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
      ).toMatchObject({ user_profile_id: `uprof_${user.id}`, status: 'connected' });
    }
  );

  it('requires operator configuration before local erasure can discard the profile identifier', async () => {
    const user = await connectedUser();
    jest.mocked(isClaudeOperatorConfigured).mockReturnValue(false);
    await expect(deleteUserClaudeProfiles(user.id)).rejects.toBeInstanceOf(
      ClaudeProfileDeletionError
    );
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ user_profile_id: `uprof_${user.id}` });
  });

  it.each([
    [{ kind: 'retry' as const }, true],
    [{ kind: 'needs_console' as const }, false],
  ])('keeps the removed payer when the unlink is %j', async (unlink, retryable) => {
    const user = await connectedUser();
    const unreferenced = await removeClaudeBillingGrant({ kind: 'personal', kiloUserId: user.id });
    if (!unreferenced) throw new Error('Expected unreferenced payer');
    jest.mocked(unlinkClaudeUserProfile).mockResolvedValue(unlink);
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    await expect(retireUnreferencedClaudeBillingPayer(unreferenced)).rejects.toMatchObject({
      retryable,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({
      id: unreferenced.id,
      status: 'removed',
      user_profile_id: `uprof_${user.id}`,
    });
  });

  it('deletes the profile when Anthropic has no link left to end', async () => {
    const user = await connectedUser();
    const unreferenced = await removeClaudeBillingGrant({ kind: 'personal', kiloUserId: user.id });
    if (!unreferenced) throw new Error('Expected unreferenced payer');
    jest.mocked(unlinkClaudeUserProfile).mockResolvedValue({ kind: 'missing' });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    await retireUnreferencedClaudeBillingPayer(unreferenced);

    expect(unlinkClaudeUserProfile).toHaveBeenCalledWith(`uprof_${user.id}`, 15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })).toBeNull();
  });

  it('ends the link of a connected profile before erasing the person', async () => {
    const user = await connectedUser();
    jest
      .mocked(unlinkClaudeUserProfile)
      .mockResolvedValue({ kind: 'unlinked', revokedConnectionIds: ['ocon_ended'] });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    await deleteUserClaudeProfiles(user.id);

    expect(unlinkClaudeUserProfile).toHaveBeenCalledWith(`uprof_${user.id}`, 15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ status: 'billing_unavailable', user_profile_id: `uprof_${user.id}` });
  });

  it.each([
    [{ kind: 'retry' as const }, true],
    [{ kind: 'needs_console' as const }, false],
  ])(
    'keeps a connected profile when the unlink before erasure is %j',
    async (unlink, retryable) => {
      const user = await connectedUser();
      jest.mocked(unlinkClaudeUserProfile).mockResolvedValue(unlink);
      const fetchMock = jest.spyOn(globalThis, 'fetch');

      await expect(deleteUserClaudeProfiles(user.id)).rejects.toMatchObject({ retryable });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
      ).toMatchObject({ status: 'connected', user_profile_id: `uprof_${user.id}` });
    }
  );

  it('retires an unshared removed payer profile and cleans up deferred removed rows', async () => {
    const user = await connectedUser();
    const unreferenced = await removeClaudeBillingGrant({ kind: 'personal', kiloUserId: user.id });
    if (!unreferenced) throw new Error('Expected unreferenced payer');

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    await expect(retireUnreferencedClaudeBillingPayer(unreferenced)).rejects.toMatchObject({
      retryable: true,
    });
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ id: unreferenced.id, status: 'removed' });

    await cleanupRemovedClaudeProfilesForUser(user.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })).toBeNull();
  });

  it('retires a removed payer whose only active grant belongs to the retired member scope', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude retired grant cleanup', user.id, 0);
    const [removed] = await db
      .insert(claude_billing_connections)
      .values({
        organization_id: organization.id,
        user_profile_id: `uprof_leftover_${user.id}`,
        status: 'removed',
        created_by: user.id,
      })
      .returning();
    if (!removed) throw new Error('Missing removed payer fixture');
    await db.insert(claude_billing_connection_grants).values({
      payer_connection_id: removed.id,
      kilo_user_id: user.id,
      organization_id: organization.id,
      created_by: user.id,
    });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    await retireUnreferencedClaudeBillingPayer({
      id: removed.id,
      userProfileId: removed.user_profile_id,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      await db
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.id, removed.id))
    ).toEqual([]);
  });

  it('continues retiring remaining removed rows when one remote delete fails', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude partial cleanup', user.id, 0);
    await db.insert(claude_billing_connections).values([
      {
        kilo_user_id: user.id,
        organization_id: null,
        user_profile_id: `uprof_fail_${user.id}`,
        status: 'removed',
        created_by: user.id,
      },
      {
        kilo_user_id: user.id,
        organization_id: org.id,
        user_profile_id: `uprof_ok_${user.id}`,
        status: 'removed',
        created_by: user.id,
      },
    ]);
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async url =>
        String(url).includes(`uprof_fail_${user.id}`)
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    await cleanupRemovedClaudeProfilesForUser(user.id);

    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ user_profile_id: `uprof_fail_${user.id}`, status: 'removed' });
    expect(
      await db
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.user_profile_id, `uprof_ok_${user.id}`))
    ).toEqual([]);
  });
});
