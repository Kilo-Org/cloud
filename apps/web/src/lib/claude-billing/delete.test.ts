jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/operator', () => ({
  getClaudeOperatorToken: jest.fn(async () => 'local-test-token'),
  isClaudeOperatorConfigured: jest.fn(() => true),
}));

import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { claude_billing_connections } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getClaudeBillingConnection } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { ClaudeProfileDeletionError, deletePersonalClaudeProfile } from './delete';

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
    await deletePersonalClaudeProfile(user.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([200, 404])('accepts deletion or authoritative absence (%s)', async status => {
    const user = await connectedUser();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status })
      );
    await deletePersonalClaudeProfile(user.id);
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ user_profile_id: `uprof_${user.id}`, status: 'billing_unavailable' });
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
      await expect(deletePersonalClaudeProfile(user.id)).rejects.toMatchObject({ retryable });
      expect(
        await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
      ).toMatchObject({ user_profile_id: `uprof_${user.id}`, status: 'connected' });
    }
  );

  it('requires operator configuration before local erasure can discard the profile identifier', async () => {
    const user = await connectedUser();
    jest.mocked(isClaudeOperatorConfigured).mockReturnValue(false);
    await expect(deletePersonalClaudeProfile(user.id)).rejects.toBeInstanceOf(
      ClaudeProfileDeletionError
    );
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ user_profile_id: `uprof_${user.id}` });
  });
});
