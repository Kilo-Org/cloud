import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

jest.mock('@/lib/config.server', () => ({
  SLACK_CLIENT_ID: 'client-id',
  SLACK_CLIENT_SECRET: 'client-secret',
}));

import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  platform_integrations,
  provider_installation_pending_credentials,
  provider_installation_reservations,
  provider_oauth_attempts,
  slack_oauth_credentials,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { beginProviderOAuthAttempt } from './provider-oauth-attempts';
import {
  claimSlackProviderInstallation,
  expireStaleSlackReservation,
} from './provider-installation-reservations';
import {
  activateReservedSlackInstallation,
  completePendingSlackDeletion,
  deleteInstallationByTeamId,
  recoverSlackInstallation,
} from './slack-service';

describe('Slack provider installation activation', () => {
  afterEach(async () => {
    await cleanupDbForTest();
  });

  const pendingCodec = {
    encryptPendingCredential: (secret: string) => Buffer.from(secret).toString('base64'),
    decryptPendingCredential: (ciphertext: string) => Buffer.from(ciphertext, 'base64').toString(),
  } as const;
  const writeCredential = async (
    tx: typeof db,
    input: { integrationId: string; slackTeamId: string }
  ) => {
    await tx
      .delete(slack_oauth_credentials)
      .where(eq(slack_oauth_credentials.platform_integration_id, input.integrationId));
    const [credential] = await tx
      .insert(slack_oauth_credentials)
      .values({
        platform_integration_id: input.integrationId,
        slack_team_id: input.slackTeamId,
        access_token_encrypted: 'encrypted-authoritative',
      })
      .returning();
    return credential;
  };

  it('rejects Enterprise Grid from the shared reservation activation path', async () => {
    await expect(
      activateReservedSlackInstallation({
        owner: { type: 'user', id: 'unused' },
        teamId: 'E_GRID',
        installation: {
          botToken: 'xoxb-enterprise',
          enterpriseId: 'E_GRID',
          isEnterpriseInstall: true,
        },
        grantedScopes: null,
        claim: { reservationId: 'unused', attemptId: null, generation: 1 },
        setChatSdkInstallation: async () => undefined,
      })
    ).rejects.toThrow('Enterprise Grid is not supported');
  });

  it('atomically activates the association, encrypted credential, and reservation', async () => {
    const actor = await insertTestUser();
    const owner = { type: 'user' as const, id: actor.id };
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'activate-state',
    });
    const claim = await claimSlackProviderInstallation({
      actorUserId: actor.id,
      owner,
      state: 'activate-state',
      teamId: 'T_ACTIVATE',
    });
    if (!claim?.attemptId) throw new Error('Expected reservation claim');
    const setInstallation = jest.fn(async () => undefined);

    const integration = await activateReservedSlackInstallation({
      owner,
      teamId: 'T_ACTIVATE',
      installation: { botToken: 'xoxb-secret', botUserId: 'U_BOT', teamName: 'Workspace' },
      grantedScopes: ['chat:write'],
      claim,
      ...pendingCodec,
      writeCredential: writeCredential as never,
      setChatSdkInstallation: setInstallation,
    });

    expect(integration.integration_status).toBe('active');
    expect(JSON.stringify(integration.metadata)).not.toContain('xoxb-secret');
    expect(setInstallation).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select()
        .from(provider_installation_reservations)
        .where(eq(provider_installation_reservations.platform_integration_id, integration.id))
    ).resolves.toEqual([expect.objectContaining({ status: 'active', generation: 1 })]);
    await expect(
      db
        .select()
        .from(provider_oauth_attempts)
        .where(eq(provider_oauth_attempts.id, claim.attemptId))
    ).resolves.toEqual([
      expect.objectContaining({ status: 'consumed', completed_integration_id: integration.id }),
    ]);
    const credentials = await db
      .select()
      .from(slack_oauth_credentials)
      .where(eq(slack_oauth_credentials.platform_integration_id, integration.id));
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.access_token_encrypted).not.toContain('xoxb-secret');
  });

  it('leaves the captured generation retryable when Chat SDK persistence fails', async () => {
    const actor = await insertTestUser();
    const owner = { type: 'user' as const, id: actor.id };
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'failure-state',
    });
    const claim = await claimSlackProviderInstallation({
      actorUserId: actor.id,
      owner,
      state: 'failure-state',
      teamId: 'T_FAILURE',
    });
    if (!claim?.attemptId) throw new Error('Expected reservation claim');

    await expect(
      activateReservedSlackInstallation({
        owner,
        teamId: 'T_FAILURE',
        installation: { botToken: 'xoxb-secret', teamName: 'Workspace' },
        grantedScopes: null,
        claim,
        ...pendingCodec,
        writeCredential: writeCredential as never,
        setChatSdkInstallation: async () => {
          throw new Error('state unavailable');
        },
      })
    ).rejects.toThrow('state unavailable');

    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, 'slack'),
            eq(platform_integrations.platform_installation_id, 'T_FAILURE')
          )
        )
    ).resolves.toEqual([expect.objectContaining({ integration_status: 'pending' })]);
    await expect(
      db
        .select()
        .from(provider_installation_reservations)
        .where(eq(provider_installation_reservations.id, claim.reservationId))
    ).resolves.toEqual([expect.objectContaining({ status: 'pending', generation: 1 })]);
    await expect(
      db
        .select()
        .from(provider_oauth_attempts)
        .where(eq(provider_oauth_attempts.id, claim.attemptId))
    ).resolves.toEqual([expect.objectContaining({ status: 'captured' })]);
    await expect(
      db
        .select()
        .from(provider_installation_pending_credentials)
        .where(eq(provider_installation_pending_credentials.reservation_id, claim.reservationId))
    ).resolves.toHaveLength(1);

    const setInstallation = jest.fn(async (_teamId: string, _installation: unknown) => undefined);
    await expect(
      recoverSlackInstallation('T_FAILURE', setInstallation as never, {
        decryptPendingCredential: pendingCodec.decryptPendingCredential as never,
        writeCredential: writeCredential as never,
      })
    ).resolves.toBe(true);
    expect(setInstallation).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select()
        .from(provider_installation_reservations)
        .where(eq(provider_installation_reservations.id, claim.reservationId))
    ).resolves.toEqual([expect.objectContaining({ status: 'active' })]);
  });

  it('restores the incumbent generation after a failed reauthorization expires', async () => {
    const actor = await insertTestUser();
    const owner = { type: 'user' as const, id: actor.id };
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'v1',
    });
    const first = await claimSlackProviderInstallation({
      actorUserId: actor.id,
      owner,
      state: 'v1',
      teamId: 'T_REAUTH',
    });
    if (!first) throw new Error('Expected first claim');
    await activateReservedSlackInstallation({
      owner,
      teamId: 'T_REAUTH',
      installation: { botToken: 'xoxb-v1', teamName: 'Workspace' },
      grantedScopes: null,
      claim: first,
      ...pendingCodec,
      writeCredential: writeCredential as never,
      setChatSdkInstallation: async () => undefined,
    });

    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'v2',
    });
    const second = await claimSlackProviderInstallation({
      actorUserId: actor.id,
      owner,
      state: 'v2',
      teamId: 'T_REAUTH',
    });
    if (!second) throw new Error('Expected replacement claim');
    await expect(
      db
        .select()
        .from(provider_installation_reservations)
        .where(eq(provider_installation_reservations.id, second.reservationId))
    ).resolves.toEqual([
      expect.objectContaining({ status: 'pending', generation: 2, active_generation: 1 }),
    ]);
    await expect(
      activateReservedSlackInstallation({
        owner,
        teamId: 'T_REAUTH',
        installation: { botToken: 'xoxb-v2', teamName: 'Workspace' },
        grantedScopes: null,
        claim: second,
        ...pendingCodec,
        writeCredential: writeCredential as never,
        setChatSdkInstallation: async () => {
          throw new Error('state unavailable');
        },
      })
    ).rejects.toThrow('state unavailable');
    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.platform_installation_id, 'T_REAUTH'))
    ).resolves.toEqual([expect.objectContaining({ integration_status: 'active' })]);

    await db
      .update(provider_installation_reservations)
      .set({ expires_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(provider_installation_reservations.id, second.reservationId));
    await expireStaleSlackReservation('T_REAUTH');
    await expect(
      db
        .select()
        .from(provider_installation_reservations)
        .where(eq(provider_installation_reservations.id, second.reservationId))
    ).resolves.toEqual([
      expect.objectContaining({ status: 'active', generation: 1, active_generation: 1 }),
    ]);
    await expect(
      db
        .select()
        .from(provider_installation_pending_credentials)
        .where(eq(provider_installation_pending_credentials.reservation_id, second.reservationId))
    ).resolves.toHaveLength(0);
  });

  it.each(['same-owner', 'other-owner'])(
    'releases an expired failed first install for %s retry',
    async retryKind => {
      const actor = await insertTestUser();
      const retryActor = retryKind === 'same-owner' ? actor : await insertTestUser();
      const owner = { type: 'user' as const, id: actor.id };
      await beginProviderOAuthAttempt({
        actorUserId: actor.id,
        owner,
        provider: 'slack',
        state: 'orphaned',
      });
      const claim = await claimSlackProviderInstallation({
        actorUserId: actor.id,
        owner,
        state: 'orphaned',
        teamId: 'T_ORPHANED',
      });
      if (!claim) throw new Error('Expected first claim');
      await expect(
        activateReservedSlackInstallation({
          owner,
          teamId: 'T_ORPHANED',
          installation: { botToken: 'xoxb-orphaned', teamName: 'Workspace' },
          grantedScopes: null,
          claim,
          ...pendingCodec,
          writeCredential: writeCredential as never,
          setChatSdkInstallation: async () => {
            throw new Error('state unavailable');
          },
        })
      ).rejects.toThrow('state unavailable');
      await db
        .update(provider_installation_reservations)
        .set({ expires_at: '2020-01-01T00:00:00.000Z' })
        .where(eq(provider_installation_reservations.id, claim.reservationId));
      await expireStaleSlackReservation('T_ORPHANED');
      await expect(
        db
          .select()
          .from(platform_integrations)
          .where(eq(platform_integrations.platform_installation_id, 'T_ORPHANED'))
      ).resolves.toHaveLength(0);

      const retryOwner = { type: 'user' as const, id: retryActor.id };
      await beginProviderOAuthAttempt({
        actorUserId: retryActor.id,
        owner: retryOwner,
        provider: 'slack',
        state: 'retry',
      });
      const retry = await claimSlackProviderInstallation({
        actorUserId: retryActor.id,
        owner: retryOwner,
        state: 'retry',
        teamId: 'T_ORPHANED',
      });
      expect(retry).toMatchObject({ generation: 1 });
      if (!retry) throw new Error('Expected retry claim');
      await expect(
        activateReservedSlackInstallation({
          owner: retryOwner,
          teamId: 'T_ORPHANED',
          installation: { botToken: 'xoxb-retry', teamName: 'Workspace' },
          grantedScopes: null,
          claim: retry,
          ...pendingCodec,
          writeCredential: writeCredential as never,
          setChatSdkInstallation: async () => undefined,
        })
      ).resolves.toMatchObject({ integration_status: 'active' });
    }
  );

  it('releases reservation locks after an SDK timeout and permits recovery', async () => {
    const actor = await insertTestUser();
    const owner = { type: 'user' as const, id: actor.id };
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'timeout-state',
    });
    const claim = await claimSlackProviderInstallation({
      actorUserId: actor.id,
      owner,
      state: 'timeout-state',
      teamId: 'T_TIMEOUT',
    });
    if (!claim) throw new Error('Expected claim');
    await expect(
      activateReservedSlackInstallation({
        owner,
        teamId: 'T_TIMEOUT',
        installation: { botToken: 'xoxb-timeout', teamName: 'Workspace' },
        grantedScopes: null,
        claim,
        ...pendingCodec,
        writeCredential: writeCredential as never,
        setChatSdkInstallation: () => new Promise(() => undefined),
        sdkTimeoutMs: 5,
      })
    ).rejects.toThrow('timed out');

    await expect(
      recoverSlackInstallation('T_TIMEOUT', async () => undefined, {
        sdkTimeoutMs: 100,
        decryptPendingCredential: pendingCodec.decryptPendingCredential as never,
        writeCredential: writeCredential as never,
      })
    ).resolves.toBe(true);
  });

  it('releases the previous workspace when an owner switches installations', async () => {
    const actor = await insertTestUser();
    const other = await insertTestUser();
    const owner = { type: 'user' as const, id: actor.id };
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'a',
    });
    const first = await claimSlackProviderInstallation({
      actorUserId: actor.id,
      owner,
      state: 'a',
      teamId: 'T_OLD',
    });
    if (!first) throw new Error('Expected first claim');
    const initial = await activateReservedSlackInstallation({
      owner,
      teamId: 'T_OLD',
      installation: { botToken: 'xoxb-old', teamName: 'Old' },
      grantedScopes: null,
      claim: first,
      ...pendingCodec,
      writeCredential: writeCredential as never,
      setChatSdkInstallation: async () => undefined,
    });

    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'b',
    });
    const replacement = await claimSlackProviderInstallation({
      actorUserId: actor.id,
      owner,
      state: 'b',
      teamId: 'T_NEW',
    });
    if (!replacement) throw new Error('Expected replacement claim');
    const replaced = await activateReservedSlackInstallation({
      owner,
      teamId: 'T_NEW',
      installation: { botToken: 'xoxb-new', teamName: 'New' },
      grantedScopes: null,
      claim: replacement,
      ...pendingCodec,
      writeCredential: writeCredential as never,
      setChatSdkInstallation: async () => undefined,
    });
    expect(replaced.id).toBe(initial.id);

    const otherOwner = { type: 'user' as const, id: other.id };
    await beginProviderOAuthAttempt({
      actorUserId: other.id,
      owner: otherOwner,
      provider: 'slack',
      state: 'other',
    });
    await expect(
      claimSlackProviderInstallation({
        actorUserId: other.id,
        owner: otherOwner,
        state: 'other',
        teamId: 'T_OLD',
      })
    ).resolves.toMatchObject({ generation: 1 });
  });

  it('ignores an uninstall event older than the active generation', async () => {
    const actor = await insertTestUser();
    const owner = { type: 'user' as const, id: actor.id };
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'uninstall-generation',
    });
    const claim = await claimSlackProviderInstallation({
      actorUserId: actor.id,
      owner,
      state: 'uninstall-generation',
      teamId: 'T_UNINSTALL',
    });
    if (!claim) throw new Error('Expected claim');
    const integration = await activateReservedSlackInstallation({
      owner,
      teamId: 'T_UNINSTALL',
      installation: { botToken: 'xoxb-current', teamName: 'Workspace' },
      grantedScopes: null,
      claim,
      ...pendingCodec,
      writeCredential: writeCredential as never,
      setChatSdkInstallation: async () => undefined,
    });
    const deleteInstallation = jest.fn(async (_teamId: string) => undefined);

    await expect(
      deleteInstallationByTeamId('T_UNINSTALL', {
        eventTime: 1,
        deleteChatSdkInstallation: deleteInstallation,
      })
    ).resolves.toEqual({ success: true, deleted: false });
    expect(deleteInstallation).not.toHaveBeenCalled();
    await expect(
      db.select().from(platform_integrations).where(eq(platform_integrations.id, integration.id))
    ).resolves.toHaveLength(1);
  });

  it('retains a deletion tombstone until lazy SDK cleanup succeeds', async () => {
    const actor = await insertTestUser();
    const other = await insertTestUser();
    const owner = { type: 'user' as const, id: actor.id };
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'delete-seed',
    });
    const seed = await claimSlackProviderInstallation({
      actorUserId: actor.id,
      owner,
      state: 'delete-seed',
      teamId: 'T_DELETING',
    });
    if (!seed) throw new Error('Expected seed claim');
    await activateReservedSlackInstallation({
      owner,
      teamId: 'T_DELETING',
      installation: { botToken: 'xoxb-current', teamName: 'Workspace' },
      grantedScopes: null,
      claim: seed,
      ...pendingCodec,
      writeCredential: writeCredential as never,
      setChatSdkInstallation: async () => undefined,
    });
    await deleteInstallationByTeamId('T_DELETING', {
      deleteChatSdkInstallation: async () => {
        throw new Error('state unavailable');
      },
    });
    await expect(
      db
        .select()
        .from(provider_installation_reservations)
        .where(eq(provider_installation_reservations.provider_installation_id, 'T_DELETING'))
    ).resolves.toEqual([expect.objectContaining({ status: 'deleting' })]);

    const retryOwner = { type: 'user' as const, id: other.id };
    await beginProviderOAuthAttempt({
      actorUserId: other.id,
      owner: retryOwner,
      provider: 'slack',
      state: 'delete-retry',
    });
    await expect(
      claimSlackProviderInstallation({
        actorUserId: other.id,
        owner: retryOwner,
        state: 'delete-retry',
        teamId: 'T_DELETING',
      })
    ).resolves.toBeNull();

    const completeDeletion = () =>
      completePendingSlackDeletion(
        'T_DELETING',
        async () => undefined,
        async () => undefined
      );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await completeDeletion()) break;
    }
  });
});
