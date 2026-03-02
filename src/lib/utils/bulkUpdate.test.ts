import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { bulkUpdate } from './bulkUpdate';
import { inArray } from 'drizzle-orm';

describe('bulkUpdate', () => {
  it('updates multiple rows in a single operation', async () => {
    const testUser1 = await insertTestUser();
    const testUser2 = await insertTestUser();

    const rowsUpdated = await bulkUpdate({
      tx: db,
      table: kilocode_users,
      idColumn: kilocode_users.id,
      valueColumn: kilocode_users.microdollars_used,
      updates: [
        { id: testUser1.id, value: 1000 },
        { id: testUser2.id, value: 2000 },
      ],
    });

    expect(rowsUpdated).toBe(2);

    const users = await db
      .select({ id: kilocode_users.id, microdollars_used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [testUser1.id, testUser2.id]));

    const userMap = new Map(users.map(u => [u.id, u.microdollars_used]));
    expect(userMap.get(testUser1.id)).toBe(1000);
    expect(userMap.get(testUser2.id)).toBe(2000);
  });

  it('returns 0 for empty updates array', async () => {
    const rowsUpdated = await bulkUpdate({
      tx: db,
      table: kilocode_users,
      idColumn: kilocode_users.id,
      valueColumn: kilocode_users.microdollars_used,
      updates: [],
    });

    expect(rowsUpdated).toBe(0);
  });
});
