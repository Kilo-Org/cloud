import { describe, test, expect } from '@jest/globals';
import { eq } from 'drizzle-orm';
import {
  kilocode_users,
  device_auth_requests,
  device_sessions,
  device_refresh_tokens,
  native_attested_keys,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { blockUser } from '@/lib/user/block';

async function getUser(id: string) {
  return db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, id),
    columns: {
      blocked_reason: true,
      blocked_at: true,
      blocked_by_kilo_user_id: true,
      api_token_pepper: true,
    },
  });
}

describe('blockUser (integration)', () => {
  test('blocks an unblocked user and rotates the api_token_pepper', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    const didBlock = await blockUser({
      kiloUserId: user.id,
      reason: 'manual block',
      blockedByKiloUserId: actor.id,
    });

    expect(didBlock).toBe(true);

    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBe('manual block');
    expect(after?.blocked_at).not.toBeNull();
    expect(after?.blocked_by_kilo_user_id).toBe(actor.id);
    expect(after?.api_token_pepper).toEqual(expect.any(String));
    expect(after?.api_token_pepper).not.toBe('initial-pepper');
  });

  test('defaults blocked_by_kilo_user_id to null when no actor is given', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    const didBlock = await blockUser({ kiloUserId: user.id, reason: 'autoban' });

    expect(didBlock).toBe(true);
    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBe('autoban');
    expect(after?.blocked_by_kilo_user_id).toBeNull();
    expect(after?.api_token_pepper).not.toBe('initial-pepper');
  });

  test('does not overwrite an existing block and leaves the pepper untouched', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'already blocked' })
      .where(eq(kilocode_users.id, user.id));

    const didBlock = await blockUser({ kiloUserId: user.id, reason: 'second reason' });

    expect(didBlock).toBe(false);
    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBe('already blocked');
    expect(after?.api_token_pepper).toBe('initial-pepper');
  });

  test('returns false for a non-existent user', async () => {
    const didBlock = await blockUser({ kiloUserId: 'does-not-exist', reason: 'nope' });
    expect(didBlock).toBe(false);
  });

  test('runs inside a provided transaction', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    await db.transaction(async tx => {
      const didBlock = await blockUser({
        kiloUserId: user.id,
        reason: 'tx block',
        dbOrTx: tx,
      });
      expect(didBlock).toBe(true);
    });

    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBe('tx block');
    expect(after?.api_token_pepper).not.toBe('initial-pepper');
  });

  test('rolls back the block (and pepper rotation) when the transaction throws', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    await expect(
      db.transaction(async tx => {
        await blockUser({ kiloUserId: user.id, reason: 'tx block', dbOrTx: tx });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBeNull();
    expect(after?.api_token_pepper).toBe('initial-pepper');
  });

  test('denies pending and approved device auth requests for a blocked user', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    // Insert a pending request
    const [pendingReq] = await db
      .insert(device_auth_requests)
      .values({
        code: 'PENDING-BLOCK',
        kilo_user_id: user.id,
        status: 'pending',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      .returning({ id: device_auth_requests.id });

    // Insert an approved request
    const [approvedReq] = await db
      .insert(device_auth_requests)
      .values({
        code: 'APPROVED-BLOCK',
        kilo_user_id: user.id,
        status: 'approved',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      .returning({ id: device_auth_requests.id });

    const didBlock = await blockUser({ kiloUserId: user.id, reason: 'device block' });

    expect(didBlock).toBe(true);

    const pending = await db.query.device_auth_requests.findFirst({
      where: eq(device_auth_requests.id, pendingReq.id),
    });
    const approved = await db.query.device_auth_requests.findFirst({
      where: eq(device_auth_requests.id, approvedReq.id),
    });

    expect(pending?.status).toBe('denied');
    expect(approved?.status).toBe('denied');
  });

  test('revokes device sessions and deletes unconsumed refresh tokens for a blocked user', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    // Create a device session
    const [session] = await db
      .insert(device_sessions)
      .values({
        kilo_user_id: user.id,
        user_agent: 'BlockTest/1.0',
      })
      .returning({ id: device_sessions.id });

    // Create an unconsumed refresh token
    const tokenHash = 'block-test-token-hash';
    await db.insert(device_refresh_tokens).values({
      token_hash: tokenHash,
      device_session_id: session.id,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const didBlock = await blockUser({ kiloUserId: user.id, reason: 'device block' });

    expect(didBlock).toBe(true);

    // Session should be revoked
    const afterSession = await db.query.device_sessions.findFirst({
      where: eq(device_sessions.id, session.id),
    });
    expect(afterSession?.revoked_at).not.toBeNull();
    expect(afterSession?.revoked_reason).toBe('user_blocked');

    // Refresh token should be deleted
    const afterToken = await db.query.device_refresh_tokens.findFirst({
      where: eq(device_refresh_tokens.token_hash, tokenHash),
    });
    expect(afterToken).toBeUndefined();
  });

  test('deletes native attested keys for a blocked user', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    // Insert a native attested key
    await db.insert(native_attested_keys).values({
      key_id: 'test-key-block',
      kilo_user_id: user.id,
      platform: 'ios',
      public_key: 'base64pubkey',
      sign_count: 0,
      attested_at: new Date().toISOString(),
    });

    const didBlock = await blockUser({ kiloUserId: user.id, reason: 'device block' });

    expect(didBlock).toBe(true);

    const afterKey = await db.query.native_attested_keys.findFirst({
      where: eq(native_attested_keys.key_id, 'test-key-block'),
    });
    expect(afterKey).toBeUndefined();
  });

  test('does not revoke an already-revoked session', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    const [session] = await db
      .insert(device_sessions)
      .values({
        kilo_user_id: user.id,
        revoked_at: new Date(Date.now() - 60_000).toISOString(),
        revoked_reason: 'manual_revoke',
      })
      .returning({ id: device_sessions.id });

    await blockUser({ kiloUserId: user.id, reason: 'device block' });

    const after = await db.query.device_sessions.findFirst({
      where: eq(device_sessions.id, session.id),
    });
    expect(after?.revoked_reason).toBe('manual_revoke');
  });

  test('rolls back device row invalidation when the transaction throws', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    const [session] = await db
      .insert(device_sessions)
      .values({
        kilo_user_id: user.id,
        user_agent: 'RollbackTest/1.0',
      })
      .returning({ id: device_sessions.id });

    const [request] = await db
      .insert(device_auth_requests)
      .values({
        code: 'ROLLBACK-BLOCK',
        kilo_user_id: user.id,
        status: 'pending',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      .returning({ id: device_auth_requests.id });

    await expect(
      db.transaction(async tx => {
        await blockUser({ kiloUserId: user.id, reason: 'tx block', dbOrTx: tx });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // User should still be unblocked
    const afterUser = await getUser(user.id);
    expect(afterUser?.blocked_reason).toBeNull();
    expect(afterUser?.api_token_pepper).toBe('initial-pepper');

    // Session should still be active
    const afterSession = await db.query.device_sessions.findFirst({
      where: eq(device_sessions.id, session.id),
    });
    expect(afterSession?.revoked_at).toBeNull();

    // Request should still be pending
    const afterRequest = await db.query.device_auth_requests.findFirst({
      where: eq(device_auth_requests.id, request.id),
    });
    expect(afterRequest?.status).toBe('pending');
  });
});
