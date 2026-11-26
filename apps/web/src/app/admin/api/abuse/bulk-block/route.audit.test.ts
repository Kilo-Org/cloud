import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { admin_action_audit_logs } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

function bulkBlockRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/admin/api/abuse/bulk-block', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function rowsOf(actorId: string) {
  return db
    .select()
    .from(admin_action_audit_logs)
    .where(eq(admin_action_audit_logs.actor_id, actorId));
}

describe('POST /admin/api/abuse/bulk-block audit rows', () => {
  it('records one row per blocked user', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const first = await insertTestUser();
    const second = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      bulkBlockRequest({
        kilo_user_emails_or_ids: [first.id, second.google_user_email],
        block_reason: `fraud ring reported by ${first.google_user_email}`,
      })
    );

    expect(response.status).toBe(200);
    const rows = await rowsOf(admin.id);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(
        [first, second].map(user =>
          expect.objectContaining({
            action: 'user.bulk_block',
            outcome: 'success',
            target_type: 'user',
            target_id: user.id,
            metadata: { blockReason: 'fraud ring reported by [redacted-email]', batchSize: 2 },
          })
        )
      )
    );
  });

  it('records a failure row when the request is refused with a 400', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const alreadyBlocked = await insertTestUser({ blocked_reason: 'earlier block' });
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      bulkBlockRequest({ kilo_user_emails_or_ids: [alreadyBlocked.id], block_reason: 'again' })
    );

    expect(response.status).toBe(400);
    expect(await rowsOf(admin.id)).toEqual([
      expect.objectContaining({
        action: 'user.bulk_block',
        outcome: 'failure',
        target_type: null,
        target_id: null,
        message: '/admin/api/abuse/bulk-block failed',
        metadata: { errorCode: '400' },
      }),
    ]);
  });
});
