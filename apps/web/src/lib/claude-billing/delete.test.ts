jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/operator', () => ({
  getClaudeOperatorToken: jest.fn(async () => 'local-test-token'),
  isClaudeOperatorConfigured: jest.fn(() => true),
}));

import { afterEach, describe, expect, it } from '@jest/globals';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { claude_billing_connections } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  getClaudeBillingConnection,
  shareClaudeBillingConnection,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { ClaudeProfileDeletionError, deleteUserClaudeProfiles } from './delete';

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(isClaudeOperatorConfigured).mockReturnValue(true);
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

  it('keeps a payer that shared services still use', async () => {
    const user = await connectedUser();
    const organization = await createTestOrganization('Claude shared erasure', user.id, 0);
    await shareClaudeBillingConnection(
      { kind: 'personal', kiloUserId: user.id },
      { kind: 'shared_services', organizationId: organization.id },
      user.id
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    await deleteUserClaudeProfiles(user.id);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ status: 'connected' });
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

  it("deletes the profiles of the person's own connections and keeps the organization's shared one", async () => {
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
      await getClaudeBillingConnection({ kind: 'shared_services', organizationId: organization.id })
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
});
