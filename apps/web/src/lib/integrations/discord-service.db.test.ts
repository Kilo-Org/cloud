import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organizations, platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { Owner } from './core/types';
import { PLATFORM } from './core/constants';
import {
  DiscordGuildAlreadyConnectedError,
  DiscordGuildRebindNotAllowedError,
  getInstallationByGuildId,
  getOwnerFromInstallation,
  upsertDiscordInstallation,
} from './discord-service';

jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test-model'),
}));

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
});
