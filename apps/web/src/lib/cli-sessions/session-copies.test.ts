import { db } from '@kilocode/web-shared/lib/drizzle';
import { sharedCliSessions } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';
import { discardReservedShare } from './session-copies';

jest.mock('@/lib/r2/cli-sessions', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/r2/cli-sessions');
  return {
    ...actual,
    deleteBlobs: jest.fn().mockResolvedValue(undefined),
  };
});

describe('discardReservedShare', () => {
  let user: User;

  beforeAll(async () => {
    user = await insertTestUser();
  });

  afterEach(async () => {
    await db.delete(sharedCliSessions).where(eq(sharedCliSessions.kilo_user_id, user.id));
  });

  it('removes a reservation that has no copied blob', async () => {
    const [row] = await db
      .insert(sharedCliSessions)
      .values({ kilo_user_id: user.id })
      .returning({ share_id: sharedCliSessions.share_id });

    await discardReservedShare(row.share_id);

    const remaining = await db
      .select({ share_id: sharedCliSessions.share_id })
      .from(sharedCliSessions)
      .where(eq(sharedCliSessions.share_id, row.share_id));

    expect(remaining).toHaveLength(0);
  });

  it('keeps a share that already carries a copied blob', async () => {
    const [row] = await db
      .insert(sharedCliSessions)
      .values({
        kilo_user_id: user.id,
        ui_messages_blob_url: 'shared-sessions/other/ui_messages.json',
      })
      .returning({ share_id: sharedCliSessions.share_id });

    await discardReservedShare(row.share_id);

    const remaining = await db
      .select({ share_id: sharedCliSessions.share_id })
      .from(sharedCliSessions)
      .where(eq(sharedCliSessions.share_id, row.share_id));

    expect(remaining).toHaveLength(1);
  });
});
