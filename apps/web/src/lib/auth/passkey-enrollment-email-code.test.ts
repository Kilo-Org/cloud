import { beforeEach, describe, expect, it } from '@jest/globals';
import { and, eq, sql } from 'drizzle-orm';
import { magic_link_tokens } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  checkPasskeyEnrollmentCode,
  createPasskeyEnrollmentCode,
  expirePasskeyEnrollmentCode,
  type PasskeyEnrollmentCodeBinding,
  type PasskeyEnrollmentEmailCode,
} from './passkey-enrollment-email-code';

const binding: PasskeyEnrollmentCodeBinding = {
  userId: 'oauth/enrollment-code-user',
  email: 'enrollment-code-user@example.com',
  webSessionId: 'enrollment-code-session',
};
const otherBinding: PasskeyEnrollmentCodeBinding = {
  userId: 'oauth/enrollment-code-other-user',
  email: 'enrollment-code-other-user@example.com',
  webSessionId: 'enrollment-code-other-session',
};

function accountRows(email: string) {
  return and(
    eq(magic_link_tokens.email, email),
    eq(magic_link_tokens.purpose, 'passkey_enrollment')
  );
}

async function newCode(forBinding = binding): Promise<PasskeyEnrollmentEmailCode> {
  const created = await createPasskeyEnrollmentCode(forBinding);
  if (created.status !== 'created') throw new Error(`no code: ${created.status}`);
  return { binding: forBinding, emailCodeId: created.emailCodeId, code: created.code };
}

/** Moves every code of the account back in time, as if `minutes` had passed. */
async function age(email: string, minutes: number): Promise<void> {
  const shift = sql.raw(`interval '${minutes} minutes'`);
  await db
    .update(magic_link_tokens)
    .set({
      created_at: sql`${magic_link_tokens.created_at} - ${shift}`,
      expires_at: sql`${magic_link_tokens.expires_at} - ${shift}`,
    })
    .where(accountRows(email));
}

function wrong(emailCode: PasskeyEnrollmentEmailCode): PasskeyEnrollmentEmailCode {
  return {
    ...emailCode,
    code: String((Number(emailCode.code) + 1) % 1_000_000).padStart(6, '0'),
  };
}

describe('passkey enrollment email codes', () => {
  beforeEach(async () => {
    await db.delete(magic_link_tokens).where(accountRows(binding.email));
    await db.delete(magic_link_tokens).where(accountRows(otherBinding.email));
  });

  it('ends the previous code when a new one is sent', async () => {
    const first = await newCode();
    await age(binding.email, 2);
    const second = await newCode();

    await expect(checkPasskeyEnrollmentCode(first)).resolves.toEqual({ status: 'expired' });
    await expect(checkPasskeyEnrollmentCode(second)).resolves.toEqual({ status: 'ok' });
  });

  it('keeps counting wrong codes across a new code', async () => {
    const first = await newCode();
    await checkPasskeyEnrollmentCode(wrong(first));
    await checkPasskeyEnrollmentCode(wrong(first));
    await age(binding.email, 2);
    const second = await newCode();

    await expect(checkPasskeyEnrollmentCode(wrong(second))).resolves.toEqual({
      status: 'invalid',
      attemptsLeft: 2,
    });
  });

  it('spends no attempt on a code that belongs to another account', async () => {
    const theirs = await newCode(otherBinding);

    await expect(checkPasskeyEnrollmentCode({ ...theirs, binding })).resolves.toEqual({
      status: 'expired',
    });
    await expect(checkPasskeyEnrollmentCode(wrong(theirs))).resolves.toEqual({
      status: 'invalid',
      attemptsLeft: 4,
    });
  });

  it('sends a new code once the lockout has passed', async () => {
    const emailCode = await newCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await checkPasskeyEnrollmentCode(wrong(emailCode));
    }
    await expect(createPasskeyEnrollmentCode(binding)).resolves.toMatchObject({
      status: 'locked',
    });

    await age(binding.email, 16);

    await expect(createPasskeyEnrollmentCode(binding)).resolves.toMatchObject({
      status: 'created',
    });
  });

  it('sends at most five codes an hour, then waits for the oldest to leave the hour', async () => {
    for (let send = 0; send < 5; send += 1) {
      await newCode();
      await age(binding.email, 2);
    }

    const capped = await createPasskeyEnrollmentCode(binding);
    expect(capped.status).toBe('hourly_limit');
    const retryAfterSeconds = capped.status === 'hourly_limit' ? capped.retryAfterSeconds : 0;
    expect(retryAfterSeconds).toBeGreaterThan(50 * 60 - 10);
    expect(retryAfterSeconds).toBeLessThanOrEqual(50 * 60);

    await age(binding.email, 51);

    await expect(createPasskeyEnrollmentCode(binding)).resolves.toMatchObject({
      status: 'created',
    });
  });

  it('keeps an expired unsent code counted for the cooldown and the hourly limit', async () => {
    const unsent = await newCode();
    await expirePasskeyEnrollmentCode(unsent.emailCodeId);

    await expect(checkPasskeyEnrollmentCode(unsent)).resolves.toEqual({ status: 'expired' });
    await expect(createPasskeyEnrollmentCode(binding)).resolves.toMatchObject({
      status: 'cooldown',
    });

    await age(binding.email, 2);
    for (let send = 0; send < 4; send += 1) {
      const next = await newCode();
      await expirePasskeyEnrollmentCode(next.emailCodeId);
      await age(binding.email, 2);
    }

    await expect(createPasskeyEnrollmentCode(binding)).resolves.toMatchObject({
      status: 'hourly_limit',
    });
    const rows = await db
      .select({ consumed_at: magic_link_tokens.consumed_at })
      .from(magic_link_tokens)
      .where(accountRows(binding.email));
    expect(rows).toHaveLength(5);
    expect(rows.every(row => row.consumed_at === null)).toBe(true);
  });

  it("removes this account's codes that count for neither the lockout nor the hourly limit", async () => {
    const theirs = await newCode(otherBinding);
    await age(otherBinding.email, 120);
    const stale = await newCode();
    await age(binding.email, 40);
    const counted = await newCode();
    await age(binding.email, 30);

    const current = await newCode();

    const rows = await db
      .select({ id: magic_link_tokens.challenge_id })
      .from(magic_link_tokens)
      .where(accountRows(binding.email));
    expect(rows.map(row => row.id).sort()).toEqual(
      [counted.emailCodeId, current.emailCodeId].sort()
    );
    expect(rows.map(row => row.id)).not.toContain(stale.emailCodeId);
    expect(
      await db
        .select({ id: magic_link_tokens.challenge_id })
        .from(magic_link_tokens)
        .where(accountRows(otherBinding.email))
    ).toEqual([{ id: theirs.emailCodeId }]);
  });
});
