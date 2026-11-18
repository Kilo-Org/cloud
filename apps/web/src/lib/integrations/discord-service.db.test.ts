import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organizations, platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { Owner } from './core/types';
import { PLATFORM } from './core/constants';
import { withWorkspaceInstallationLock } from './oauth/workspace-installation-lock';
import {
  DiscordGuildAlreadyConnectedError,
  DiscordGuildRebindNotAllowedError,
  getInstallation,
  getInstallationByGuildId,
  getOwnerFromInstallation,
  upsertDiscordInstallation,
} from './discord-service';

jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test-model'),
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
      .where(eq(platform_integrations.id, created.id));

    const updated = await upsertDiscordInstallation(
      owner,
      {
        ...response,
        guild: { id: selectedGuild, name: 'Selected Test Server', icon: 'test-icon' },
      },
      { allowGuildRebind: owner.type === 'org' }
    );

    expect(updated.id).toBe(created.id);
    expect(updated.platform_installation_id).toBe(selectedGuild);
    expect(updated.platform_account_id).toBe(selectedGuild);
    expect(updated.metadata).toEqual({
      model_slug: 'configured-model',
      custom_setting: true,
      guild_icon: 'test-icon',
    });
    const installation = await getInstallationByGuildId(selectedGuild);
    expect(installation?.id).toBe(created.id);
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
      .where(eq(platform_integrations.id, created.id));
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
        .where(eq(platform_integrations.id, bound.id));
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
      expect(installation?.id).toBe(canonical.id);

      const updated = await upsertDiscordInstallation({ type: 'org', id: orgId }, response, {
        allowGuildRebind: true,
      });
      expect(updated.id).toBe(canonical.id);
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

    expect(updated.id).toBe(canonicalId);
    expect(updated.platform_installation_id).toBe(guild.id);
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

      expect(created.platform_installation_id).toBe('122345678901234567');
      expect((await getInstallationByGuildId('122345678901234567'))?.id).toBe(created.id);
    } finally {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, otherOrgId));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
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
