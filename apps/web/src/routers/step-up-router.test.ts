import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';

jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(async () => false),
}));

const originalMode = process.env.ADMIN_STEP_UP_MODE;
const createdUserIds: string[] = [];

async function admin() {
  const user = await insertTestUser({ is_admin: true, web_session_pepper: 'router-pepper' });
  createdUserIds.push(user.id);
  return user;
}

/**
 * Remove the step-up proofs table for the duration of one assertion, so a
 * missing migration (or any primary DB failure) is injected for real.
 */
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
  process.env.ADMIN_STEP_UP_MODE = originalMode;
  for (const userId of createdUserIds.splice(0)) {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
});

describe('stepUp.getStatus', () => {
  it('returns an off-mode placeholder without touching step-up tables', async () => {
    process.env.ADMIN_STEP_UP_MODE = 'off';
    const user = await admin();
    const caller = await createSessionCallerForUser(user.id);

    const status = await withoutProofsTable(() => caller.stepUp.getStatus());

    expect(status).toMatchObject({
      mode: 'off',
      status: { status: 'absent' },
      enrollmentEnabled: false,
      enrolled: false,
      fresh: false,
      sessionBound: true,
    });
  });
});

describe('stepUp.revokeCurrent', () => {
  it('rejects a bearer credential', async () => {
    const user = await admin();
    const caller = await createCallerForUser(user.id);

    await expect(caller.stepUp.revokeCurrent()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns a generic error when the proof revocation fails', async () => {
    process.env.ADMIN_STEP_UP_MODE = 'observe';
    const user = await admin();
    const caller = await createSessionCallerForUser(user.id);

    const error: unknown = await withoutProofsTable(() =>
      caller.stepUp.revokeCurrent().then(
        () => null,
        (rejection: unknown) => rejection
      )
    );

    expect(error).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Could not lock this session. Try again.',
    });
    expect(JSON.stringify(error)).not.toContain('session_step_up_proofs');
  });
});
