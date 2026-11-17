import { describe, expect, it } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  device_sessions,
  kilocode_users,
  passkey_management_authorizations,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

import {
  approvePasskeyManagementSsoRequest,
  bindPasskeyManagementChallenge,
  collectPasskeyManagementSsoGrant,
  consumePasskeyManagementAuthorization,
  createPasskeyManagementSsoRequest,
  deleteExpiredPasskeyManagementAuthorizations,
  hasActiveNativeDeviceSession,
  mintPasskeyManagementAuthorization,
  readPasskeyManagementSsoRequest,
  readPasskeyManagementSsoRequestForApproval,
  validatePasskeyManagementAuthorization,
} from './passkey-management';

/** A native app session: no device-auth request, so it is not a CLI session. */
async function insertNativeSession(kiloUserId: string): Promise<string> {
  const [row] = await db
    .insert(device_sessions)
    .values({ kilo_user_id: kiloUserId, user_agent: 'Kilo mobile test' })
    .returning({ id: device_sessions.id });
  return row!.id;
}

/**
 * A session the app minted through its browser sign-in. That flow records the
 * request in `device_auth_request_id`; the column records how the session was
 * signed in, not which client owns it.
 */
async function insertBrowserSignedInSession(kiloUserId: string): Promise<string> {
  const [row] = await db
    .insert(device_sessions)
    .values({
      kilo_user_id: kiloUserId,
      device_auth_request_id: randomUUID(),
      user_agent: 'Kilo-Code/1.0.0 (android)',
    })
    .returning({ id: device_sessions.id });
  return row!.id;
}

async function grantCount(kiloUserId: string): Promise<number> {
  const rows = await db
    .select({ id: passkey_management_authorizations.id })
    .from(passkey_management_authorizations)
    .where(eq(passkey_management_authorizations.kilo_user_id, kiloUserId));
  return rows.length;
}

describe('passkey management authorizations', () => {
  it('mints a grant that validates and is redeemed exactly once', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);

    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'enroll',
    });

    const check = {
      token: minted.token,
      userId: user.id,
      deviceSessionId,
      operation: 'enroll' as const,
    };

    await expect(validatePasskeyManagementAuthorization(check)).resolves.toBe(true);
    await expect(consumePasskeyManagementAuthorization(check)).resolves.toBe(true);
    // The second redemption is a replay and matches no row.
    await expect(consumePasskeyManagementAuthorization(check)).resolves.toBe(false);
    await expect(validatePasskeyManagementAuthorization(check)).resolves.toBe(false);
  });

  it('refuses a grant minted for another operation', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'rename',
    });

    await expect(
      consumePasskeyManagementAuthorization({
        token: minted.token,
        userId: user.id,
        deviceSessionId,
        operation: 'remove',
      })
    ).resolves.toBe(false);
    await expect(grantCount(user.id)).resolves.toBe(1);
  });

  it('refuses a grant presented by another account', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();
    const ownerSession = await insertNativeSession(owner.id);
    const otherSession = await insertNativeSession(other.id);
    const minted = await mintPasskeyManagementAuthorization({
      userId: owner.id,
      deviceSessionId: ownerSession,
      operation: 'remove',
    });

    await expect(
      consumePasskeyManagementAuthorization({
        token: minted.token,
        userId: other.id,
        deviceSessionId: otherSession,
        operation: 'remove',
      })
    ).resolves.toBe(false);
  });

  it('refuses a grant replayed from another session of the same account', async () => {
    const user = await insertTestUser();
    const firstSession = await insertNativeSession(user.id);
    const secondSession = await insertNativeSession(user.id);
    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId: firstSession,
      operation: 'remove',
    });

    await expect(
      consumePasskeyManagementAuthorization({
        token: minted.token,
        userId: user.id,
        deviceSessionId: secondSession,
        operation: 'remove',
      })
    ).resolves.toBe(false);
  });

  it('refuses a grant once its device session is revoked', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'enroll',
    });

    await db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString(), revoked_reason: 'test_revocation' })
      .where(eq(device_sessions.id, deviceSessionId));

    const check = {
      token: minted.token,
      userId: user.id,
      deviceSessionId,
      operation: 'enroll' as const,
    };
    await expect(validatePasskeyManagementAuthorization(check)).resolves.toBe(false);
    await expect(consumePasskeyManagementAuthorization(check)).resolves.toBe(false);
  });

  it('accepts the app session its browser sign-in created', async () => {
    const user = await insertTestUser();
    // SSO and OAuth sign-ins in the app run through the browser, so their
    // sessions carry `device_auth_request_id`. Excluding those sessions would
    // make passkey management impossible for every SSO-only account.
    const deviceSessionId = await insertBrowserSignedInSession(user.id);

    await expect(hasActiveNativeDeviceSession({ deviceSessionId, userId: user.id })).resolves.toBe(
      true
    );

    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'remove',
    });
    await expect(
      consumePasskeyManagementAuthorization({
        token: minted.token,
        userId: user.id,
        deviceSessionId,
        operation: 'remove',
      })
    ).resolves.toBe(true);
  });

  it('redeems a grant once when many callers present it at the same time', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'remove',
    });
    const check = {
      token: minted.token,
      userId: user.id,
      deviceSessionId,
      operation: 'remove' as const,
    };

    const outcomes = await Promise.all([
      consumePasskeyManagementAuthorization(check),
      consumePasskeyManagementAuthorization(check),
      consumePasskeyManagementAuthorization(check),
      consumePasskeyManagementAuthorization(check),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await expect(validatePasskeyManagementAuthorization(check)).resolves.toBe(false);
  });

  it('refuses every concurrent redemption of a revoked session’s grant', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'rename',
    });
    await db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString(), revoked_reason: 'test_revocation' })
      .where(eq(device_sessions.id, deviceSessionId));

    const outcomes = await Promise.all([
      consumePasskeyManagementAuthorization({
        token: minted.token,
        userId: user.id,
        deviceSessionId,
        operation: 'rename',
      }),
      consumePasskeyManagementAuthorization({
        token: minted.token,
        userId: user.id,
        deviceSessionId,
        operation: 'rename',
      }),
    ]);

    expect(outcomes).toEqual([false, false]);
    // A refused redemption spends nothing, so a later retry from a live
    // session still sees an unspent grant.
    const [row] = await db
      .select({ consumed_at: passkey_management_authorizations.consumed_at })
      .from(passkey_management_authorizations)
      .where(eq(passkey_management_authorizations.id, minted.id));
    expect(row?.consumed_at).toBeNull();
  });

  it('refuses an expired grant', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'enroll',
    });

    await db
      .update(passkey_management_authorizations)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(passkey_management_authorizations.id, minted.id));

    await expect(
      validatePasskeyManagementAuthorization({
        token: minted.token,
        userId: user.id,
        deviceSessionId,
        operation: 'enroll',
      })
    ).resolves.toBe(false);
  });

  it('refuses an unknown token', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);

    await expect(
      consumePasskeyManagementAuthorization({
        token: 'not-a-minted-token',
        userId: user.id,
        deviceSessionId,
        operation: 'enroll',
      })
    ).resolves.toBe(false);
  });

  it('binds an enrollment challenge so only that pair verifies', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'enroll',
    });
    const challengeId = randomUUID();

    await expect(
      bindPasskeyManagementChallenge({
        token: minted.token,
        userId: user.id,
        deviceSessionId,
        challengeId,
      })
    ).resolves.toBe(true);

    const base = {
      token: minted.token,
      userId: user.id,
      deviceSessionId,
      operation: 'enroll' as const,
    };
    await expect(
      validatePasskeyManagementAuthorization({ ...base, challengeId: randomUUID() })
    ).resolves.toBe(false);
    await expect(validatePasskeyManagementAuthorization({ ...base, challengeId })).resolves.toBe(
      true
    );
    await expect(
      consumePasskeyManagementAuthorization({ ...base, challengeId: randomUUID() })
    ).resolves.toBe(false);
    await expect(consumePasskeyManagementAuthorization({ ...base, challengeId })).resolves.toBe(
      true
    );
  });

  it('can be retried after a cancelled ceremony', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    const minted = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'enroll',
    });
    const base = {
      token: minted.token,
      userId: user.id,
      deviceSessionId,
      operation: 'enroll' as const,
    };

    const firstChallenge = randomUUID();
    await bindPasskeyManagementChallenge({ ...base, challengeId: firstChallenge });
    // The platform ceremony was cancelled, so the app asks for options again
    // with the same grant. That step consumes nothing and may rebind.
    const secondChallenge = randomUUID();
    await expect(
      bindPasskeyManagementChallenge({ ...base, challengeId: secondChallenge })
    ).resolves.toBe(true);
    await expect(
      validatePasskeyManagementAuthorization({ ...base, challengeId: secondChallenge })
    ).resolves.toBe(true);
    await expect(
      consumePasskeyManagementAuthorization({ ...base, challengeId: secondChallenge })
    ).resolves.toBe(true);
  });

  it('cleans up only expired grants', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    const live = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'enroll',
    });
    const stale = await mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation: 'remove',
    });
    await db
      .update(passkey_management_authorizations)
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(passkey_management_authorizations.id, stale.id));

    await deleteExpiredPasskeyManagementAuthorizations(new Date().toISOString());

    const remaining = await db
      .select({ id: passkey_management_authorizations.id })
      .from(passkey_management_authorizations)
      .where(
        and(
          eq(passkey_management_authorizations.kilo_user_id, user.id),
          eq(passkey_management_authorizations.id, live.id)
        )
      );
    expect(remaining).toHaveLength(1);
    await expect(grantCount(user.id)).resolves.toBe(1);
  });

  describe('SSO approval phases', () => {
    const organizationId = 'org_sso_required';

    async function startRequest(kiloUserId: string, deviceSessionId: string) {
      return createPasskeyManagementSsoRequest({
        userId: kiloUserId,
        deviceSessionId,
        operation: 'enroll',
        ssoOrganizationId: organizationId,
      });
    }

    it('authorizes nothing until the browser approves and the app collects', async () => {
      const user = await insertTestUser();
      const deviceSessionId = await insertNativeSession(user.id);
      const started = await startRequest(user.id, deviceSessionId);

      await expect(
        readPasskeyManagementSsoRequest({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId,
        })
      ).resolves.toEqual({
        state: 'pending',
        operation: 'enroll',
        ssoOrganizationId: organizationId,
      });
      await expect(
        collectPasskeyManagementSsoGrant({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId,
        })
      ).resolves.toBeNull();
      // The public request id is not a grant: presenting it as one matches no
      // issued row.
      await expect(
        consumePasskeyManagementAuthorization({
          token: started.requestId,
          userId: user.id,
          deviceSessionId,
          operation: 'enroll',
        })
      ).resolves.toBe(false);
    });

    it('issues the grant once the same account approves it', async () => {
      const user = await insertTestUser();
      const deviceSessionId = await insertNativeSession(user.id);
      const started = await startRequest(user.id, deviceSessionId);

      await expect(
        approvePasskeyManagementSsoRequest({
          requestId: started.requestId,
          userId: user.id,
          ssoOrganizationId: organizationId,
        })
      ).resolves.toBe('enroll');

      const grant = await collectPasskeyManagementSsoGrant({
        requestId: started.requestId,
        userId: user.id,
        deviceSessionId,
      });
      if (!grant) {
        throw new Error('a collected grant was expected');
      }
      const check = {
        token: grant.token,
        userId: user.id,
        deviceSessionId,
        operation: 'enroll' as const,
      };
      await expect(validatePasskeyManagementAuthorization(check)).resolves.toBe(true);
      await expect(consumePasskeyManagementAuthorization(check)).resolves.toBe(true);

      // Collection is single-use: the request cannot yield a second grant.
      await expect(
        collectPasskeyManagementSsoGrant({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId,
        })
      ).resolves.toBeNull();
      await expect(
        readPasskeyManagementSsoRequestForApproval(started.requestId)
      ).resolves.toMatchObject({ state: 'issued' });
    });

    it('refuses an approval from another account or another organization', async () => {
      const owner = await insertTestUser();
      const other = await insertTestUser();
      const deviceSessionId = await insertNativeSession(owner.id);
      const started = await startRequest(owner.id, deviceSessionId);

      await expect(
        approvePasskeyManagementSsoRequest({
          requestId: started.requestId,
          userId: other.id,
          ssoOrganizationId: organizationId,
        })
      ).resolves.toBeNull();
      await expect(
        approvePasskeyManagementSsoRequest({
          requestId: started.requestId,
          userId: owner.id,
          ssoOrganizationId: 'org_other',
        })
      ).resolves.toBeNull();
      await expect(
        readPasskeyManagementSsoRequestForApproval(started.requestId)
      ).resolves.toMatchObject({
        userId: owner.id,
        operation: 'enroll',
        ssoOrganizationId: organizationId,
        state: 'pending',
      });
    });

    it('refuses an expired request at approval and at collection', async () => {
      const user = await insertTestUser();
      const deviceSessionId = await insertNativeSession(user.id);
      const started = await startRequest(user.id, deviceSessionId);
      await db
        .update(passkey_management_authorizations)
        .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(passkey_management_authorizations.id, started.requestId));

      await expect(
        approvePasskeyManagementSsoRequest({
          requestId: started.requestId,
          userId: user.id,
          ssoOrganizationId: organizationId,
        })
      ).resolves.toBeNull();
      await expect(
        collectPasskeyManagementSsoGrant({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId,
        })
      ).resolves.toBeNull();
    });

    it('refuses an approved request once its device session is revoked', async () => {
      const user = await insertTestUser();
      const deviceSessionId = await insertNativeSession(user.id);
      const started = await startRequest(user.id, deviceSessionId);
      await approvePasskeyManagementSsoRequest({
        requestId: started.requestId,
        userId: user.id,
        ssoOrganizationId: organizationId,
      });
      await db
        .update(device_sessions)
        .set({ revoked_at: new Date().toISOString(), revoked_reason: 'test_revocation' })
        .where(eq(device_sessions.id, deviceSessionId));

      await expect(
        collectPasskeyManagementSsoGrant({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId,
        })
      ).resolves.toBeNull();
    });

    it('refuses collection from another session of the same account', async () => {
      const user = await insertTestUser();
      const requestingSession = await insertNativeSession(user.id);
      const otherSession = await insertNativeSession(user.id);
      const started = await startRequest(user.id, requestingSession);
      await approvePasskeyManagementSsoRequest({
        requestId: started.requestId,
        userId: user.id,
        ssoOrganizationId: organizationId,
      });

      await expect(
        readPasskeyManagementSsoRequest({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId: otherSession,
        })
      ).resolves.toBeNull();
      await expect(
        collectPasskeyManagementSsoGrant({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId: otherSession,
        })
      ).resolves.toBeNull();
    });

    it('issues the grant to exactly one of several concurrent collectors', async () => {
      const user = await insertTestUser();
      const deviceSessionId = await insertNativeSession(user.id);
      const started = await startRequest(user.id, deviceSessionId);
      await approvePasskeyManagementSsoRequest({
        requestId: started.requestId,
        userId: user.id,
        ssoOrganizationId: organizationId,
      });

      const collected = await Promise.all([
        collectPasskeyManagementSsoGrant({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId,
        }),
        collectPasskeyManagementSsoGrant({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId,
        }),
        collectPasskeyManagementSsoGrant({
          requestId: started.requestId,
          userId: user.id,
          deviceSessionId,
        }),
      ]);

      const grants = collected.filter(grant => grant !== null);
      expect(grants).toHaveLength(1);
      const [firstGrant] = grants;
      if (!firstGrant) {
        throw new Error('a collected grant was expected');
      }
      await expect(
        validatePasskeyManagementAuthorization({
          token: firstGrant.token,
          userId: user.id,
          deviceSessionId,
          operation: 'enroll',
        })
      ).resolves.toBe(true);
    });

    it('refuses a grant minted before account recovery', async () => {
      const user = await insertTestUser();
      const deviceSessionId = await insertNativeSession(user.id);
      const minted = await mintPasskeyManagementAuthorization({
        userId: user.id,
        deviceSessionId,
        operation: 'remove',
      });

      // Account recovery rotates the pepper; the session rows stay live, so
      // the pepper is what invalidates a grant minted before it.
      await db
        .update(kilocode_users)
        .set({ web_session_pepper: randomUUID() })
        .where(eq(kilocode_users.id, user.id));

      await expect(
        consumePasskeyManagementAuthorization({
          token: minted.token,
          userId: user.id,
          deviceSessionId,
          operation: 'remove',
        })
      ).resolves.toBe(false);
    });
  });
});
