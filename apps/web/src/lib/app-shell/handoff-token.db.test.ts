import { afterAll, describe, expect, it } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { app_shell_handoff_tokens } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { consumeAppShellHandoff, createAppShellHandoff } from './handoff-token';

const createdUserIds: string[] = [];

async function mintHandoff(targetPath: string) {
  const user = await insertTestUser();
  createdUserIds.push(user.id);
  const token = await createAppShellHandoff({ userId: user.id, targetPath });
  return { token, userId: user.id };
}

describe('app shell hand-off tokens', () => {
  afterAll(async () => {
    for (const userId of createdUserIds) {
      await db
        .delete(app_shell_handoff_tokens)
        .where(eq(app_shell_handoff_tokens.kilo_user_id, userId));
    }
  });

  it('consumes a token exactly once, for the user it was minted for', async () => {
    const { token, userId } = await mintHandoff('/app-shell/github-app');

    const first = await consumeAppShellHandoff(token);
    expect(first).toEqual({ userId, targetPath: '/app-shell/github-app' });

    // A replay — a second browser, or a refreshed tab — gets nothing.
    await expect(consumeAppShellHandoff(token)).resolves.toBeNull();

    const [row] = await db
      .select()
      .from(app_shell_handoff_tokens)
      .where(eq(app_shell_handoff_tokens.kilo_user_id, userId));
    expect(row?.consumed_at).not.toBeNull();
  });

  it('refuses a token whose expiry has passed', async () => {
    const { token, userId } = await mintHandoff('/app-shell/connected-accounts');

    await db
      .update(app_shell_handoff_tokens)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(
        and(
          eq(app_shell_handoff_tokens.kilo_user_id, userId),
          eq(app_shell_handoff_tokens.target_path, '/app-shell/connected-accounts')
        )
      );

    await expect(consumeAppShellHandoff(token)).resolves.toBeNull();
  });

  it('refuses an unknown token', async () => {
    await expect(consumeAppShellHandoff('not-a-minted-token')).resolves.toBeNull();
    await expect(consumeAppShellHandoff('')).resolves.toBeNull();
  });

  it('stores only a digest of the token', async () => {
    const { token, userId } = await mintHandoff('/app-shell/integrations/slack');

    const rows = await db
      .select()
      .from(app_shell_handoff_tokens)
      .where(eq(app_shell_handoff_tokens.kilo_user_id, userId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toHaveLength(64);
  });

  it('refuses to mint a token for a path outside the shell', async () => {
    const user = await insertTestUser();
    createdUserIds.push(user.id);

    await expect(
      createAppShellHandoff({ userId: user.id, targetPath: '/credits' })
    ).rejects.toThrow(/app-shell/);
  });
});
