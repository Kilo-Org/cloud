import { describe, expect, it, afterEach } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createBearerCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';

const originalSwitch = process.env.ADMIN_STEP_UP_ENABLED;
const createdUserIds: string[] = [];

async function admin() {
  const user = await insertTestUser({ is_admin: true, web_session_pepper: 'router-pepper' });
  createdUserIds.push(user.id);
  return user;
}

async function withoutProofsTable<T>(run: () => Promise<T>): Promise<T> {
  const hidden = `session_step_up_proofs_hidden_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.execute(sql.raw(`ALTER TABLE session_step_up_proofs RENAME TO ${hidden}`));
  try {
    return await run();
  } finally {
    await db.execute(sql.raw(`ALTER TABLE ${hidden} RENAME TO session_step_up_proofs`));
  }
}

afterEach(async () => {
  process.env.ADMIN_STEP_UP_ENABLED = originalSwitch;
  for (const userId of createdUserIds.splice(0)) {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
});

describe('stepUp.getStatus', () => {
  it('returns an off placeholder without touching step-up tables', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'false';
    const user = await admin();
    const caller = await createSessionCallerForUser(user.id);

    const status = await withoutProofsTable(() => caller.stepUp.getStatus());

    expect(status).toMatchObject({
      status: { status: 'absent' },
      enrolled: false,
      fresh: false,
      sessionBound: true,
    });
    expect(status).not.toHaveProperty('mode');
    expect(status).not.toHaveProperty('enrollmentEnabled');
  });

  it('returns an unavailable placeholder when the status read fails while on', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    const user = await admin();
    const caller = await createSessionCallerForUser(user.id);

    const status = await withoutProofsTable(() => caller.stepUp.getStatus());

    expect(status).toMatchObject({
      status: { status: 'absent' },
      unavailable: true,
      fresh: false,
      sessionBound: true,
    });
  });

  it('refuses a bearer credential', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    const user = await admin();
    const caller = await createBearerCallerForUser(user.id);

    await expect(caller.stepUp.getStatus()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
