jest.mock('@/lib/config.server', () => ({
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
}));

const mockLimit = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateReturning = jest.fn();
const mockInsertValues = jest.fn();
const mockInsertReturning = jest.fn();

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: mockLimit,
        })),
      })),
    })),
    update: jest.fn(() => ({
      set: mockUpdateSet,
    })),
    insert: jest.fn(() => ({
      values: mockInsertValues,
    })),
    delete: jest.fn(() => ({
      where: jest.fn(),
    })),
  },
}));

jest.mock('@/lib/organizations/organizations', () => ({
  getOrganizationById: jest.fn(),
}));

jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'gpt-test'),
}));

jest.mock('@/lib/model-allow.server', () => ({
  createAllowPredicateFromRestrictions: jest.fn(),
  hasActiveModelRestrictions: jest.fn(() => false),
}));

jest.mock('@/lib/organizations/model-restrictions', () => ({
  getEffectiveModelRestrictions: jest.fn(),
}));

import type { Owner } from '@/lib/integrations/core/types';
import {
  addDiscordReaction,
  postDiscordMessage,
  removeDiscordReaction,
  testConnection,
  upsertDiscordInstallation,
} from './discord-service';

const owner = { type: 'user', id: 'user-1' } satisfies Owner;

function buildDiscordIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'integration-1',
    integration_status: 'active',
    platform_account_id: '123456789012345678',
    platform_installation_id: '123456789012345678',
    owned_by_user_id: owner.id,
    owned_by_organization_id: null,
    metadata: {},
    ...overrides,
  };
}

describe('discord-service API URL validation', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('does not post a message when the channel ID is malformed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(postDiscordMessage('123/../456', 'hello')).resolves.toEqual({
      ok: false,
      error: 'Invalid Discord channel ID',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not post a reply when the message reference ID is malformed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(
      postDiscordMessage('123456789012345678', 'hello', {
        messageReference: { message_id: '123?x=1' },
      })
    ).resolves.toEqual({ ok: false, error: 'Invalid Discord message reference ID' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not add a reaction when the message ID is malformed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(addDiscordReaction('123456789012345678', 'message/1', '✅')).resolves.toEqual({
      ok: false,
      error: 'Invalid Discord message ID',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not remove a reaction when the channel ID is malformed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(removeDiscordReaction('channel#1', '123456789012345678', '✅')).resolves.toEqual({
      ok: false,
      error: 'Invalid Discord channel ID',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses fixed-origin Discord API URLs for valid message posts', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: '234567890123456789' }), { status: 200 })
      );

    await expect(postDiscordMessage('123456789012345678', 'hello')).resolves.toEqual({
      ok: true,
      messageId: '234567890123456789',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/123456789012345678/messages',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

describe('discord-service persisted guild ID validation', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockLimit.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();
  });

  it('does not test a connection when the stored guild ID is malformed', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration({ platform_account_id: 'guild/1' })]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(testConnection(owner)).resolves.toEqual({
      success: false,
      error: 'Invalid guild ID found for this installation',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed OAuth guild IDs before persistence', async () => {
    mockLimit.mockResolvedValue([]);

    await expect(
      upsertDiscordInstallation(owner, {
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-token',
        scope: 'bot guilds',
        guild: { id: 'guild/1', name: 'Test Guild', icon: null },
      })
    ).rejects.toThrow('Invalid Discord guild ID');

    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('tests valid stored guild IDs through the fixed Discord API origin', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration()]);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await expect(testConnection(owner)).resolves.toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledWith('https://discord.com/api/v10/guilds/123456789012345678', {
      headers: { Authorization: 'Bot bot-token' },
    });
  });
});
