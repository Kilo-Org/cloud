import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organizations, platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { Owner } from './core/types';
import { INTEGRATION_STATUS, PLATFORM } from './core/constants';
import { isPlatformIntegrationActive } from './core/health';
import { withWorkspaceInstallationLock } from './oauth/workspace-installation-lock';
import {
  DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
  DiscordGuildAlreadyConnectedError,
  DiscordGuildRebindNotAllowedError,
  getInstallation,
  getInstallationByGuildId,
  getOwnerFromInstallation,
  uninstallApp,
  upsertDiscordInstallation,
} from './discord-service';

jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test-model'),
}));

// The removal path returns `unavailable` before it fetches when no bot token is
// configured, so the authenticated-test environment supplies one.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/config.server'),
  DISCORD_BOT_TOKEN: 'bot-token',
}));

const mockCaptureException = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

/**
 * Persists a connection row directly, in either identifier shape the service
 * reads: with the server in both columns, or only in `platform_account_id`.
 */
async function insertDiscordRow(
  owner: Owner,
  guild: { id: string; name: string; icon: string | null },
  { installationId = guild.id }: { installationId?: string | null } = {}
): Promise<string> {
  const [row] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      platform: PLATFORM.DISCORD,
      integration_type: 'oauth',
      platform_installation_id: installationId,
      platform_account_id: guild.id,
      platform_account_login: guild.name,
      scopes: ['bot', 'guilds'],
      integration_status: 'active',
      metadata: { guild_icon: guild.icon },
    })
    .returning({ id: platform_integrations.id });

  return row.id;
}

describe('Discord installation lifecycle', () => {
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();

  beforeAll(async () => {
    await db.insert(kilocode_users).values({
      id: userId,
      google_user_email: `${userId}@example.com`,
      google_user_name: 'Discord Test',
      google_user_image_url: 'https://example.com/avatar.png',
      stripe_customer_id: `cus_discord_${userId}`,
    });
    await db.insert(organizations).values({ id: orgId, name: 'Discord Test' });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, userId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, orgId));
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  });

  it.each<Owner>([
    { type: 'user', id: userId },
    { type: 'org', id: orgId },
  ])('persists the selected installation for $type ownership', async owner => {
    const firstGuild = '123456789012345678';
    const selectedGuild = '234567890123456789';
    const response = {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'bot guilds',
      guild: { id: firstGuild, name: 'First Test Server', icon: null },
    };
    const created = await upsertDiscordInstallation(owner, response);
    await db
      .update(platform_integrations)
      .set({
        metadata: { model_slug: 'configured-model', custom_setting: true },
      })
      .where(eq(platform_integrations.id, created.integration.id));

    const updated = await upsertDiscordInstallation(
      owner,
      {
        ...response,
        guild: { id: selectedGuild, name: 'Selected Test Server', icon: 'test-icon' },
      },
      { allowGuildRebind: owner.type === 'org' }
    );

    expect(updated.integration.id).toBe(created.integration.id);
    expect(updated.previousGuildId).toBe(firstGuild);
    expect(updated.integration.platform_installation_id).toBe(selectedGuild);
    expect(updated.integration.platform_account_id).toBe(selectedGuild);
    expect(updated.integration.metadata).toEqual({
      model_slug: 'configured-model',
      custom_setting: true,
      guild_icon: 'test-icon',
    });
    const installation = await getInstallationByGuildId(selectedGuild);
    expect(installation?.id).toBe(created.integration.id);
    expect(installation && getOwnerFromInstallation(installation)).toEqual(owner);
    expect(await getInstallationByGuildId(firstGuild)).toBeNull();
  });

  it('keeps an organization connection on its server without rebind authority', async () => {
    const owner: Owner = { type: 'org', id: orgId };
    const response = {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'bot guilds',
      guild: { id: '345678901234567890', name: 'Bound Server', icon: null },
    };
    const created = await upsertDiscordInstallation(owner, response);

    await expect(
      upsertDiscordInstallation(owner, {
        ...response,
        guild: { id: '456789012345678901', name: 'Other Server', icon: null },
      })
    ).rejects.toThrow(DiscordGuildRebindNotAllowedError);

    const [stored] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, created.integration.id));
    expect(stored.platform_installation_id).toBe('345678901234567890');
    expect(stored.platform_account_login).toBe('Bound Server');
  });

  it('rejects a server already connected to another owner', async () => {
    const otherOrgId = crypto.randomUUID();
    await db.insert(organizations).values({ id: otherOrgId, name: 'Discord Other' });
    const guild = { id: '567890123456789012', name: 'Shared Server', icon: null };
    const response = {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'bot guilds',
      guild,
    };

    try {
      const bound = await upsertDiscordInstallation({ type: 'org', id: otherOrgId }, response);

      await expect(
        upsertDiscordInstallation({ type: 'org', id: orgId }, response, {
          allowGuildRebind: true,
        })
      ).rejects.toThrow(DiscordGuildAlreadyConnectedError);

      const [stored] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, bound.integration.id));
      expect(stored.owned_by_organization_id).toBe(otherOrgId);
      expect(stored.platform_installation_id).toBe(guild.id);
      const rows = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DISCORD),
            eq(platform_integrations.owned_by_organization_id, orgId)
          )
        );
      expect(rows).toHaveLength(0);
    } finally {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, otherOrgId));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
  });

  it('refuses a server another owner keeps without the canonical column', async () => {
    const otherOrgId = crypto.randomUUID();
    await db.insert(organizations).values({ id: otherOrgId, name: 'Discord Legacy' });
    const guild = { id: '789012345678901234', name: 'Legacy Server', icon: null };

    try {
      await insertDiscordRow({ type: 'org', id: otherOrgId }, guild, { installationId: null });

      await expect(
        upsertDiscordInstallation(
          { type: 'org', id: orgId },
          {
            access_token: 'test-access',
            refresh_token: 'test-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'bot guilds',
            guild,
          },
          { allowGuildRebind: true }
        )
      ).rejects.toThrow(DiscordGuildAlreadyConnectedError);

      const legacy = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, otherOrgId));
      expect(legacy).toHaveLength(1);
      expect(legacy[0].platform_installation_id).toBeNull();
      expect(legacy[0].platform_account_id).toBe(guild.id);

      const claimed = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, orgId));
      expect(claimed).toHaveLength(0);
    } finally {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, otherOrgId));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
  });

  it('resolves events for a server kept without the canonical column', async () => {
    const owner: Owner = { type: 'user', id: userId };
    const guild = { id: '890123456789012345', name: 'Account Column Server', icon: null };

    await insertDiscordRow(owner, guild, { installationId: null });

    const installation = await getInstallationByGuildId(guild.id);
    expect(installation && getOwnerFromInstallation(installation)).toEqual(owner);
    expect(installation?.platform_installation_id).toBeNull();
  });

  it('keeps the canonical row for a server ahead of an account-column row', async () => {
    const otherOrgId = crypto.randomUUID();
    await db.insert(organizations).values({ id: otherOrgId, name: 'Discord Stale' });
    const guild = { id: '901234567890123456', name: 'Canonical Server', icon: null };
    const response = {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'bot guilds',
      guild,
    };

    try {
      const canonical = await upsertDiscordInstallation({ type: 'org', id: orgId }, response);
      await insertDiscordRow({ type: 'org', id: otherOrgId }, guild, { installationId: null });

      const installation = await getInstallationByGuildId(guild.id);
      expect(installation?.id).toBe(canonical.integration.id);

      const updated = await upsertDiscordInstallation({ type: 'org', id: orgId }, response, {
        allowGuildRebind: true,
      });
      expect(updated.integration.id).toBe(canonical.integration.id);
    } finally {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, otherOrgId));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
  });

  it('updates the row that carries the server in the installation column', async () => {
    const owner: Owner = { type: 'org', id: orgId };
    const guild = { id: '131234567890123456', name: 'Canonical Update Server', icon: null };
    const response = {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'bot guilds',
      guild,
    };

    // Both identifier shapes exist for one connection, the account-column row first.
    await insertDiscordRow(owner, guild, { installationId: null });
    const canonicalId = await insertDiscordRow(owner, guild);

    expect((await getInstallation(owner))?.id).toBe(canonicalId);

    const updated = await upsertDiscordInstallation(owner, response, { allowGuildRebind: true });

    expect(updated.integration.id).toBe(canonicalId);
    expect(updated.integration.platform_installation_id).toBe(guild.id);
    const rows = await db
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, orgId));
    expect(rows).toHaveLength(2);
  });

  it('connects an unrelated server while another owner holds a different one', async () => {
    const otherOrgId = crypto.randomUUID();
    await db.insert(organizations).values({ id: otherOrgId, name: 'Discord Elsewhere' });

    try {
      await insertDiscordRow(
        { type: 'org', id: otherOrgId },
        { id: '112345678901234567', name: 'Elsewhere Server', icon: null },
        { installationId: null }
      );

      const created = await upsertDiscordInstallation(
        { type: 'org', id: orgId },
        {
          access_token: 'test-access',
          refresh_token: 'test-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'bot guilds',
          guild: { id: '122345678901234567', name: 'Own Server', icon: null },
        },
        { allowGuildRebind: true }
      );

      expect(created.integration.platform_installation_id).toBe('122345678901234567');
      expect((await getInstallationByGuildId('122345678901234567'))?.id).toBe(
        created.integration.id
      );
    } finally {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, otherOrgId));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
  });

  it('keeps a disconnect for a server a second connection records in the account column', async () => {
    // Real Postgres proof that the ownership check reads both identifier
    // columns: the second row carries the server only in `platform_account_id`,
    // so the disconnect is kept while that row exists.
    const otherUserId = crypto.randomUUID();
    await db.insert(kilocode_users).values({
      id: otherUserId,
      google_user_email: `${otherUserId}@example.com`,
      google_user_name: 'Discord Legacy Duplicate',
      google_user_image_url: 'https://example.com/avatar.png',
      stripe_customer_id: `cus_discord_dup_${otherUserId}`,
    });
    const guild = { id: '432109876543210987', name: 'Legacy Duplicate Server', icon: null };

    try {
      const ownRowId = await insertDiscordRow({ type: 'user', id: userId }, guild);
      const secondRowId = await insertDiscordRow({ type: 'user', id: otherUserId }, guild, {
        installationId: null,
      });
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));

      await expect(uninstallApp({ type: 'user', id: userId })).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { source: 'discord_disconnect', op: 'shared_server' },
        extra: { guildId: guild.id },
      });

      const survivors = await db
        .select({ id: platform_integrations.id })
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DISCORD),
            eq(platform_integrations.platform_account_id, guild.id)
          )
        );
      expect(survivors.map(row => row.id).sort()).toEqual([ownRowId, secondRowId].sort());
    } finally {
      jest.restoreAllMocks();
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_user_id, otherUserId));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, otherUserId));
    }
  });

  it('removes the rows of this owner that record the released server', async () => {
    // A connection can carry the server in both identifier columns, so a
    // disconnect removes each row that records the server it released.
    const guild = { id: '543210987654321098', name: 'Sibling Row Server', icon: null };

    const canonicalId = await insertDiscordRow({ type: 'user', id: userId }, guild);
    const legacyId = await insertDiscordRow({ type: 'user', id: userId }, guild, {
      installationId: null,
    });
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(uninstallApp({ type: 'user', id: userId })).resolves.toEqual({ success: true });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const remaining = await db
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.DISCORD),
          eq(platform_integrations.owned_by_user_id, userId),
          eq(platform_integrations.platform_account_id, guild.id)
        )
      );
    expect(remaining.map(row => row.id)).not.toContain(canonicalId);
    expect(remaining.map(row => row.id)).not.toContain(legacyId);
    expect(remaining).toHaveLength(0);
  });

  it('serializes two owners connecting the same server', async () => {
    const otherOrgId = crypto.randomUUID();
    await db.insert(organizations).values({ id: otherOrgId, name: 'Discord Contender' });
    const guild = { id: '678901234567890123', name: 'Contended Server', icon: null };
    const response = {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'bot guilds',
      guild,
    };

    try {
      const results = await Promise.allSettled([
        withWorkspaceInstallationLock('discord', { type: 'org', id: orgId }, guild.id, tx =>
          upsertDiscordInstallation({ type: 'org', id: orgId }, response, {}, tx)
        ),
        withWorkspaceInstallationLock('discord', { type: 'org', id: otherOrgId }, guild.id, tx =>
          upsertDiscordInstallation({ type: 'org', id: otherOrgId }, response, {}, tx)
        ),
      ]);

      const rejected = results.filter(result => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        DiscordGuildAlreadyConnectedError
      );

      const rows = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DISCORD),
            eq(platform_integrations.platform_installation_id, guild.id)
          )
        );
      expect(rows).toHaveLength(1);
    } finally {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, otherOrgId));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
  });
});

describe('Discord re-authorization of a recorded association', () => {
  const userId = crypto.randomUUID();

  beforeAll(async () => {
    await db.insert(kilocode_users).values({
      id: userId,
      google_user_email: `${userId}@example.com`,
      google_user_name: 'Discord Suspension Test',
      google_user_image_url: 'https://example.com/avatar.png',
      stripe_customer_id: `cus_discord_susp_${userId}`,
    });
  });

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, userId));
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  });

  it('records an active association without a suspension', async () => {
    const owner: Owner = { type: 'user', id: userId };
    const guild = { id: '345678901234567890', name: 'Suspension Server', icon: null };
    const created = await upsertDiscordInstallation(owner, {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'bot guilds',
      guild,
    });
    await db
      .update(platform_integrations)
      .set({
        integration_status: 'suspended',
        suspended_at: '2026-11-20T00:00:00.000Z',
        suspended_by: 'integration-operator',
      })
      .where(eq(platform_integrations.id, created.integration.id));

    const reauthorized = await upsertDiscordInstallation(owner, {
      access_token: 'test-access-2',
      refresh_token: 'test-refresh-2',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'bot guilds',
      guild: { ...guild, name: 'Renamed Server' },
    });

    expect(reauthorized.integration.id).toBe(created.integration.id);
    expect(reauthorized.previousGuildId).toBeNull();
    expect(reauthorized.integration.integration_status).toBe(INTEGRATION_STATUS.ACTIVE);
    expect(reauthorized.integration.suspended_at).toBeNull();
    expect(reauthorized.integration.suspended_by).toBeNull();
    expect(isPlatformIntegrationActive(reauthorized.integration)).toBe(true);
  });
});
