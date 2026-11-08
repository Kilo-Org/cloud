import { describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { claude_billing_connections } from '@kilocode/db/schema';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import { POST } from './route';

function request(owner: unknown, authorized = true) {
  return new Request('http://localhost/api/internal/claude-billing/payer-state', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': authorized ? INTERNAL_API_SECRET : 'incorrect-secret',
    },
    body: JSON.stringify(owner),
  });
}

describe('Authoritative Claude payer state', () => {
  it('requires internal authentication before disclosing a connection', async () => {
    const response = await POST(request({ kind: 'personal', kiloUserId: 'private-owner' }, false));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('distinguishes authoritative absence from a failed lookup', async () => {
    const response = await POST(request({ kind: 'personal', kiloUserId: 'absent-owner' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection: null });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('normalizes timestamps and observes removal on the next read', async () => {
    const user = await insertTestUser();
    const [row] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: user.id,
        user_profile_id: `uprof_${user.id}`,
        created_by: user.id,
        status: 'connected',
        connected_at: '2026-01-01T00:00:00.123Z',
      })
      .returning();
    if (!row) throw new Error('Missing connection fixture');
    const owner = { kind: 'personal', kiloUserId: user.id };
    const connected = await POST(request(owner));
    expect(await connected.json()).toEqual({
      connection: {
        status: 'connected',
        user_profile_id: row.user_profile_id,
        connected_at: '2026-01-01T00:00:00.123Z',
      },
    });
    await db
      .update(claude_billing_connections)
      .set({ status: 'removed', connected_at: null })
      .where(eq(claude_billing_connections.id, row.id));
    const removed = await POST(request(owner));
    expect(await removed.json()).toEqual({
      connection: { status: 'removed', user_profile_id: row.user_profile_id, connected_at: null },
    });
  });

  it('rejects invalid ownership before querying another account', async () => {
    expect((await POST(request({ kind: 'organization', organizationId: 'invalid' }))).status).toBe(
      400
    );
  });
});
