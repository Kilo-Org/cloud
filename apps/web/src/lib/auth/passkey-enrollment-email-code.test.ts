import { beforeEach, describe, expect, it } from '@jest/globals';
import { and, eq, sql } from 'drizzle-orm';
import { magic_link_tokens } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  checkPasskeyEnrollmentCode,
  createPasskeyEnrollmentCode,
  deleteExpiredPasskeyEnrollmentCodes,
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

  it('removes only codes whose attempts no longer count', async () => {
    const counted = await newCode(otherBinding);
    await newCode();
    await age(binding.email, 26);

    await deleteExpiredPasskeyEnrollmentCodes();

    expect(
      await db
        .select({ id: magic_link_tokens.challenge_id })
        .from(magic_link_tokens)
        .where(accountRows(binding.email))
    ).toEqual([]);
    expect(
      await db
        .select({ id: magic_link_tokens.challenge_id })
        .from(magic_link_tokens)
        .where(accountRows(otherBinding.email))
    ).toEqual([{ id: counted.emailCodeId }]);
  });
});
