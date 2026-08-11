import { and, eq, sql } from 'drizzle-orm';
import { magic_link_tokens } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import {
  consumeDataExportDownloadCode,
  createDataExportDownloadCode,
  deleteDataExportDownloadCode,
  releaseDataExportDownloadCode,
  reserveDataExportDownloadCode,
  __test__,
} from './data-export-download-codes';
import { createSignInCode, reserveSignInCode } from './magic-link-tokens';

const testEmail = 'data-export-code@example.com';
const exportId = '11111111-1111-4111-8111-111111111111';
const otherExportId = '22222222-2222-4222-8222-222222222222';

/** Mint a code without the resend cooldown blocking a follow-up test. */
async function mintCode(email = testEmail, forExportId = exportId) {
  const created = await createDataExportDownloadCode(email, forExportId);
  if (created.status !== 'created') throw new Error(`expected a code, got ${created.status}`);
  return created;
}

function wrongCodeFor(code: string): string {
  const shifted = (Number(code) + 1) % 1_000_000;
  return String(shifted).padStart(6, '0');
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM magic_link_tokens WHERE email = ${testEmail}`);
});

describe('data export download codes', () => {
  it('mints a six-digit code stored only as a keyed hash', async () => {
    const { code, challengeId } = await mintCode();

    expect(code).toMatch(/^\d{6}$/);
    const [row] = await db
      .select()
      .from(magic_link_tokens)
      .where(eq(magic_link_tokens.challenge_id, challengeId));
    expect(row.purpose).toBe('data_export_download');
    expect(row.token_hash).toBe(__test__.hashDownloadCode(testEmail, exportId, code));
    expect(row.token_hash).not.toContain(code);
  });

  it('authorizes one download and refuses the code afterwards', async () => {
    const { code, challengeId } = await mintCode();

    await expect(
      reserveDataExportDownloadCode(testEmail, exportId, code, challengeId)
    ).resolves.toBe('ok');
    await consumeDataExportDownloadCode(challengeId);

    // A signed URL already exists at this point, so the code must not mint a second one.
    await expect(
      reserveDataExportDownloadCode(testEmail, exportId, code, challengeId)
    ).resolves.toBe('invalid');
  });

  it('does not authorize a different export than the one it was minted for', async () => {
    const { code, challengeId } = await mintCode();

    await expect(
      reserveDataExportDownloadCode(testEmail, otherExportId, code, challengeId)
    ).resolves.toBe('invalid');
  });

  it('does not authorize a different account', async () => {
    const { code, challengeId } = await mintCode();

    await expect(
      reserveDataExportDownloadCode('someone-else@example.com', exportId, code, challengeId)
    ).resolves.toBe('invalid');
  });

  it('spends the attempt budget on wrong codes and then locks the challenge', async () => {
    const { code, challengeId } = await mintCode();
    const wrong = wrongCodeFor(code);

    for (let attempt = 0; attempt < __test__.CODE_MAX_ATTEMPTS; attempt++) {
      await expect(
        reserveDataExportDownloadCode(testEmail, exportId, wrong, challengeId)
      ).resolves.toBe('invalid');
    }

    // The budget is exhausted, so even the correct code is refused.
    await expect(
      reserveDataExportDownloadCode(testEmail, exportId, code, challengeId)
    ).resolves.toBe('too_many_attempts');
  });

  it('blocks a concurrent redemption of the same code and reopens it on release', async () => {
    const { code, challengeId } = await mintCode();

    await expect(
      reserveDataExportDownloadCode(testEmail, exportId, code, challengeId)
    ).resolves.toBe('ok');
    await expect(
      reserveDataExportDownloadCode(testEmail, exportId, code, challengeId)
    ).resolves.toBe('in_progress');

    // Failing to mint the URL is not a wrong guess, so the code stays usable.
    await releaseDataExportDownloadCode(challengeId);
    await expect(
      reserveDataExportDownloadCode(testEmail, exportId, code, challengeId)
    ).resolves.toBe('ok');
  });

  it('refuses an expired code', async () => {
    const { code, challengeId } = await mintCode();
    // `check_expires_at_future` forbids backdating expiry alone.
    await db
      .update(magic_link_tokens)
      .set({
        created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      })
      .where(eq(magic_link_tokens.challenge_id, challengeId));

    await expect(
      reserveDataExportDownloadCode(testEmail, exportId, code, challengeId)
    ).resolves.toBe('invalid');
  });

  it('throttles resends and replaces the previous code once the cooldown passes', async () => {
    const first = await mintCode();

    await expect(createDataExportDownloadCode(testEmail, exportId)).resolves.toEqual({
      status: 'cooldown',
    });

    await db
      .update(magic_link_tokens)
      .set({
        created_at: new Date(
          Date.now() - (__test__.RESEND_COOLDOWN_SECONDS + 1) * 1000
        ).toISOString(),
      })
      .where(eq(magic_link_tokens.challenge_id, first.challengeId));

    const second = await mintCode();
    expect(second.challengeId).not.toBe(first.challengeId);
    // Only one live download code exists per account, so the old one is gone.
    await expect(
      reserveDataExportDownloadCode(testEmail, exportId, first.code, first.challengeId)
    ).resolves.toBe('invalid');
  });

  it('drops an undeliverable code', async () => {
    const { code, challengeId } = await mintCode();

    await deleteDataExportDownloadCode(challengeId);

    await expect(
      reserveDataExportDownloadCode(testEmail, exportId, code, challengeId)
    ).resolves.toBe('invalid');
  });

  describe('purpose isolation from sign-in codes', () => {
    it('does not accept a sign-in code as a download code', async () => {
      const signIn = await createSignInCode(testEmail);

      await expect(
        reserveDataExportDownloadCode(testEmail, exportId, signIn.code, signIn.challengeId)
      ).resolves.toBe('invalid');
    });

    it('does not let a download code sign the account in', async () => {
      const download = await mintCode();

      // A download code redeemable at /api/auth/native/token would be a session.
      await expect(reserveSignInCode(testEmail, download.code, download.challengeId)).resolves.toBe(
        'invalid'
      );
    });

    it('leaves a live sign-in code untouched when a download code is minted', async () => {
      const signIn = await createSignInCode(testEmail);

      await mintCode();

      await expect(reserveSignInCode(testEmail, signIn.code, signIn.challengeId)).resolves.toBe(
        'ok'
      );
    });
  });

  it('rejects an unknown purpose at the database boundary', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO magic_link_tokens (token_hash, email, expires_at, purpose)
        VALUES ('unknown-purpose-hash', ${testEmail}, NOW() + interval '10 minutes', 'not_a_purpose')
      `)
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ constraint: 'check_magic_link_tokens_purpose' }),
    });
  });
});

afterAll(async () => {
  await db
    .delete(magic_link_tokens)
    .where(and(eq(magic_link_tokens.email, testEmail)))
    .catch(() => undefined);
});
