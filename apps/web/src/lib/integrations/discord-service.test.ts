jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
}));

const mockLimit = jest.fn();
const mockTxReadLimit = jest.fn();
const mockTxGuardLimit = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateReturning = jest.fn();
const mockInsertValues = jest.fn();
const mockInsertReturning = jest.fn();
const mockDeleteWhere = jest.fn();
const mockTxExecute = jest.fn();
const mockTransaction = jest.fn();
const mockSelect = jest.fn(() => ({
  from: jest.fn(() => ({
    where: jest.fn(() => ({
      orderBy: jest.fn(() => ({
        limit: mockLimit,
      })),
      limit: mockLimit,
    })),
  })),
}));
/**
 * A locked section's own reads, kept apart from `db.select()`. The row read
 * takes the ordered chain, and the single-statement ownership check takes the
 * unordered one, so each result is installed for exactly one of them.
 */
const mockTxSelect = jest.fn(() => ({
  from: jest.fn(() => ({
    where: jest.fn(() => ({
      orderBy: jest.fn(() => ({
        limit: mockTxReadLimit,
      })),
      limit: mockTxGuardLimit,
    })),
  })),
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => mockSelect(),
    update: jest.fn(() => ({
      set: mockUpdateSet,
    })),
    insert: jest.fn(() => ({
      values: mockInsertValues,
    })),
    delete: jest.fn(() => ({
      where: mockDeleteWhere,
    })),
    // Accessed lazily: jest.mock factories hoist above the const declarations.
    get transaction() {
      return mockTransaction;
    },
  },
}));

jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  getOrganizationById: jest.fn(),
}));

const mockGetDefaultAllowedModel = jest.fn();
jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: (...args: unknown[]) => mockGetDefaultAllowedModel(...args),
}));

jest.mock('@kilocode/web-shared/lib/model-allow.server', () => ({
  createAllowPredicateFromRestrictions: jest.fn(),
  hasActiveModelRestrictions: jest.fn(() => false),
}));

jest.mock('@/lib/organizations/model-restrictions', () => ({
  getEffectiveModelRestrictions: jest.fn(),
}));

const mockCaptureException = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Owner } from '@/lib/integrations/core/types';
import {
  INSTALLATION_LOCK_WAIT_MS,
  INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS,
  withWorkspaceInstallationLock,
} from '@/lib/integrations/oauth/workspace-installation-lock';
import {
  addDiscordReaction,
  DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
  DISCORD_DISCONNECT_REMOVAL_TIMEOUT_MS,
  DISCORD_DISCONNECT_UNCONFIRMED_MESSAGE,
  DISCORD_RELEASE_REMOVAL_TIMEOUT_MS,
  postDiscordMessage,
  releasePreviousDiscordGuild,
  removeBotFromGuild,
  removeDiscordReaction,
  testConnection,
  uninstallApp,
  upsertDiscordInstallation,
} from './discord-service';

const owner = { type: 'user', id: 'user-1' } satisfies Owner;

/** The text of a drizzle `sql` statement, so a test can name the statement it ran. */
function statementText(statement: unknown): string {
  if (!statement || typeof statement !== 'object' || !('queryChunks' in statement)) {
    return '';
  }
  const { queryChunks } = statement;
  if (!Array.isArray(queryChunks)) return '';

  return queryChunks
    .map(chunk => {
      if (typeof chunk === 'string') return chunk;
      if (!chunk || typeof chunk !== 'object' || !('value' in chunk)) return '';
      const value = chunk.value;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('');
}

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

describe('discord-service organization install model', () => {
  const orgOwner = { type: 'org', id: 'org-1' } satisfies Owner;

  const oauthResponse = {
    access_token: 'access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-token',
    scope: 'bot guilds',
    guild: { id: '123456789012345678', name: 'Test Guild', icon: null },
  };

  beforeEach(() => {
    mockLimit.mockReset();
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();
    mockGetDefaultAllowedModel.mockReset();
    mockLimit.mockResolvedValue([]);
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    mockInsertReturning.mockResolvedValue([buildDiscordIntegration()]);
  });

  it('stores no model when the organization policy allows none', async () => {
    mockGetDefaultAllowedModel.mockResolvedValue(null);

    await upsertDiscordInstallation(orgOwner, oauthResponse);

    const inserted = mockInsertValues.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect('model_slug' in inserted.metadata).toBe(false);
    expect(inserted.metadata).toMatchObject({ guild_icon: null });
  });

  it('stores the allowed model for the organization', async () => {
    mockGetDefaultAllowedModel.mockResolvedValue('test/allowed-model');

    await upsertDiscordInstallation(orgOwner, oauthResponse);

    const inserted = mockInsertValues.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(inserted.metadata.model_slug).toBe('test/allowed-model');
  });

  it('stores the model the caller resolved', async () => {
    mockGetDefaultAllowedModel.mockResolvedValue('test/unused-model');

    await upsertDiscordInstallation(orgOwner, oauthResponse, {
      defaultModel: 'test/caller-model',
    });

    const inserted = mockInsertValues.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(inserted.metadata.model_slug).toBe('test/caller-model');
    expect(mockGetDefaultAllowedModel).not.toHaveBeenCalled();
  });
});

describe('discord-service rebind result', () => {
  const oauthResponse = {
    access_token: 'access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-token',
    scope: 'bot guilds',
    guild: { id: '222222222222222222', name: 'New Server', icon: null },
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    mockLimit.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateReturning.mockResolvedValue([
      buildDiscordIntegration({
        platform_installation_id: oauthResponse.guild.id,
        platform_account_id: oauthResponse.guild.id,
      }),
    ]);
  });

  it('reports the server a re-authorization moved the connection away from', async () => {
    mockLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        buildDiscordIntegration({
          platform_installation_id: '111111111111111111',
          platform_account_id: '111111111111111111',
        }),
      ]);

    const result = await upsertDiscordInstallation(owner, oauthResponse);

    expect(result.integration.id).toBe('integration-1');
    expect(result.previousGuildId).toBe('111111111111111111');
  });

  it('reports the server a row records only in the account column', async () => {
    mockLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        buildDiscordIntegration({
          platform_installation_id: null,
          platform_account_id: '111111111111111111',
        }),
      ]);

    const result = await upsertDiscordInstallation(owner, oauthResponse);

    expect(result.previousGuildId).toBe('111111111111111111');
  });

  it('reports no previous server when the owner re-authorizes the same one', async () => {
    mockLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        buildDiscordIntegration({
          platform_installation_id: oauthResponse.guild.id,
          platform_account_id: oauthResponse.guild.id,
        }),
      ]);

    const result = await upsertDiscordInstallation(owner, oauthResponse);

    expect(result.previousGuildId).toBeNull();
  });

  it('reports no previous server for a first connection', async () => {
    mockLimit.mockResolvedValue([]);
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    mockInsertReturning.mockResolvedValue([buildDiscordIntegration()]);

    const result = await upsertDiscordInstallation(owner, oauthResponse);

    expect(result.previousGuildId).toBeNull();
    expect(result.integration.id).toBe('integration-1');
  });
});

describe('discord-service previous guild release', () => {
  const guildId = '111111111111111111';
  const otherOwner = { type: 'user', id: 'user-2' } satisfies Owner;
  const lockState = { depth: 0 };

  beforeEach(() => {
    jest.restoreAllMocks();
    mockCaptureException.mockReset();
    mockLimit.mockReset();
    mockLimit.mockResolvedValue([]);
    mockTxExecute.mockReset();
    mockTxExecute.mockResolvedValue([]);
    mockTransaction.mockReset();
    lockState.depth = 0;
    mockTransaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) => {
      lockState.depth += 1;
      try {
        return await operation({ execute: mockTxExecute, select: mockSelect });
      } finally {
        lockState.depth -= 1;
      }
    });
  });

  it('leaves a server that is not exclusively its own alone', async () => {
    mockLimit.mockResolvedValueOnce([buildDiscordIntegration({ owned_by_user_id: otherOwner.id })]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(releasePreviousDiscordGuild(owner, guildId)).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('holds only the server lock, not the owner lock', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await releasePreviousDiscordGuild(owner, guildId);

    const lockStatements = mockTxExecute.mock.calls
      .map(([statement]) => statementText(statement))
      .filter(text => text.includes('pg_advisory_xact_lock'));
    expect(lockStatements).toHaveLength(1);
    expect(lockStatements[0]).toContain(`integration-installation:discord:${guildId}`);
    expect(lockStatements[0]).not.toContain('integration-installation-owner');
  });

  it('bounds the release section at its worst case below the lock wait', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await releasePreviousDiscordGuild(owner, guildId);

    const statements = mockTxExecute.mock.calls.map(([statement]) => statementText(statement));
    const statementBudgets = statements.filter(text => text.includes('statement_timeout'));
    expect(statementBudgets).toHaveLength(1);
    expect(statementBudgets[0]).toContain(`'${INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS}ms'`);
    expect(statements.some(text => text.includes("statement_timeout = '30s'"))).toBe(false);
    expect(
      statements.some(text => text.includes(`lock_timeout = '${INSTALLATION_LOCK_WAIT_MS}ms'`))
    ).toBe(true);
    // A statement budget is per statement, and the guard read runs up to two
    // lookups: the canonical query and the legacy account-column fallback.
    expect(
      2 * INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS + DISCORD_RELEASE_REMOVAL_TIMEOUT_MS
    ).toBeLessThan(INSTALLATION_LOCK_WAIT_MS);
  });

  it('takes the server lock before lowering the statement budget', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await releasePreviousDiscordGuild(owner, guildId);

    const statements = mockTxExecute.mock.calls.map(([statement]) => statementText(statement));
    const lockIndex = statements.findIndex(text => text.includes('pg_advisory_xact_lock'));
    const budgetIndex = statements.findIndex(text => text.includes('statement_timeout'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(budgetIndex).toBeGreaterThan(lockIndex);
  });

  it('renders the connect lock wait from the shared constant', async () => {
    await withWorkspaceInstallationLock('discord', owner, guildId, async () => undefined);

    const statements = mockTxExecute.mock.calls.map(([statement]) => statementText(statement));
    expect(
      statements.some(text => text.includes(`lock_timeout = '${INSTALLATION_LOCK_WAIT_MS}ms'`))
    ).toBe(true);
    expect(statements.some(text => text.includes("lock_timeout = '5s'"))).toBe(false);
  });

  it.each([204, 404])('leaves the server without reporting a %i answer', async status => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      expect(lockState.depth).toBe(1);
      return new Response(null, { status });
    });

    await expect(releasePreviousDiscordGuild(owner, guildId)).resolves.toBeUndefined();

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://discord.com/api/v10/users/%40me/guilds/${guildId}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bot bot-token' },
      })
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('bounds the release removal below the lock wait', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await releasePreviousDiscordGuild(owner, guildId);

    expect(timeoutSpy).toHaveBeenCalledWith(DISCORD_RELEASE_REMOVAL_TIMEOUT_MS);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(timeoutSpy.mock.results[0]?.value);
  });

  it.each([
    [500, 'response_error'],
    [429, 'rate_limited'],
  ] as const)('reports a %i answer without throwing', async (status, reason) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));

    await expect(releasePreviousDiscordGuild(owner, guildId)).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'discord_oauth', op: 'release_previous_guild' },
      extra: { guildId, status: 'temporary_failure', reason },
    });
  });

  it('reports an unusable bot token without throwing', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(releasePreviousDiscordGuild(owner, guildId)).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'discord_oauth', op: 'release_previous_guild' },
      extra: { guildId, status: 'unavailable', reason: 'rejected_token' },
    });
  });

  it('reports a failed lookup without rejecting', async () => {
    const lookupError = new Error('connection terminated');
    mockLimit.mockRejectedValueOnce(lookupError);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(releasePreviousDiscordGuild(owner, guildId)).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(lookupError, {
      tags: { source: 'discord_oauth', op: 'release_previous_guild' },
      extra: { guildId, outcome: 'lookup_failed' },
    });
  });
});

describe('discord-service bot removal', () => {
  const guildId = '123456789012345678';

  beforeEach(() => {
    jest.restoreAllMocks();
    mockDeleteWhere.mockReset();
  });

  it('removes the bot from the recorded server with the bot token', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(removeBotFromGuild(guildId)).resolves.toEqual({ status: 'left' });

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://discord.com/api/v10/users/%40me/guilds/${guildId}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bot bot-token' },
      })
    );
  });

  it.each([403, 404])('treats a %i answer as a membership that is already gone', async status => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));

    await expect(removeBotFromGuild(guildId)).resolves.toEqual({ status: 'already_absent' });
  });

  it.each([
    [429, 'rate_limited'],
    [500, 'response_error'],
    [503, 'response_error'],
  ] as const)('reports a %i answer as a temporary failure', async (status, reason) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));

    await expect(removeBotFromGuild(guildId)).resolves.toEqual({
      status: 'temporary_failure',
      reason,
    });
  });

  it('reports a rejected bot token as unavailable', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(removeBotFromGuild(guildId)).resolves.toEqual({
      status: 'unavailable',
      reason: 'rejected_token',
    });
  });

  it('reports a transport failure as a temporary failure', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'));

    await expect(removeBotFromGuild(guildId)).resolves.toEqual({
      status: 'temporary_failure',
      reason: 'network',
    });
  });

  it.each([[null], ['']])('reports a connection without a server id as unavailable', async id => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(removeBotFromGuild(id)).resolves.toEqual({
      status: 'unavailable',
      reason: 'invalid_guild_id',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a malformed server id as unavailable', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(removeBotFromGuild('guild/1')).resolves.toEqual({
      status: 'unavailable',
      reason: 'invalid_guild_id',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('discord-service uninstall', () => {
  const guildId = '123456789012345678';
  const movedGuildId = '223456789012345678';
  const stillMovingGuildId = '323456789012345678';
  const lockState = { depth: 0 };

  beforeEach(() => {
    jest.restoreAllMocks();
    mockCaptureException.mockReset();
    mockLimit.mockReset();
    mockTxReadLimit.mockReset();
    mockTxGuardLimit.mockReset();
    mockDeleteWhere.mockReset();
    mockTxExecute.mockReset();
    mockTxExecute.mockResolvedValue([]);
    mockTransaction.mockReset();
    mockTxGuardLimit.mockResolvedValue([]);
    lockState.depth = 0;
    mockTransaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) => {
      lockState.depth += 1;
      try {
        return await operation({
          execute: mockTxExecute,
          select: mockTxSelect,
          delete: () => ({ where: mockDeleteWhere }),
        });
      } finally {
        lockState.depth -= 1;
      }
    });
  });

  it.each([204, 404])(
    'removes the bot and deletes the association on a %i answer',
    async status => {
      mockLimit.mockResolvedValue([buildDiscordIntegration()]);
      mockTxReadLimit.mockResolvedValue([buildDiscordIntegration()]);
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        expect(lockState.depth).toBe(1);
        return new Response(null, { status });
      });
      const deleteDepths: number[] = [];
      mockDeleteWhere.mockImplementation(async () => {
        deleteDepths.push(lockState.depth);
      });

      await expect(uninstallApp(owner)).resolves.toEqual({ success: true });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://discord.com/api/v10/users/%40me/guilds/${guildId}`,
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(timeoutSpy).toHaveBeenCalledWith(DISCORD_DISCONNECT_REMOVAL_TIMEOUT_MS);
      expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
      expect(deleteDepths).toEqual([1]);
      expect(mockCaptureException).not.toHaveBeenCalled();
    }
  );

  it('keeps the association when Discord does not confirm the removal', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration()]);
    mockTxReadLimit.mockResolvedValue([buildDiscordIntegration()]);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));

    await expect(uninstallApp(owner)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: DISCORD_DISCONNECT_UNCONFIRMED_MESSAGE,
    });
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('keeps the association when Discord rejects the bot token', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration()]);
    mockTxReadLimit.mockResolvedValue([buildDiscordIntegration()]);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(uninstallApp(owner)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
    });
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('keeps the association when the server cannot be identified', async () => {
    mockLimit.mockResolvedValue([
      buildDiscordIntegration({ platform_installation_id: null, platform_account_id: null }),
    ]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(uninstallApp(owner)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('reports a missing association without calling Discord', async () => {
    mockLimit.mockResolvedValue([]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(uninstallApp(owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('reports a row that disappears while the lock is held as missing', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration()]);
    mockTxReadLimit.mockResolvedValue([]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(uninstallApp(owner)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Discord installation not found',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('keeps the row and the membership for a server that is not exclusively its own', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration()]);
    mockTxReadLimit.mockResolvedValue([buildDiscordIntegration()]);
    mockTxGuardLimit.mockResolvedValue([{ id: 'other-integration' }]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(uninstallApp(owner)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'discord_disconnect', op: 'shared_server' },
      extra: { guildId },
    });
  });

  it('names the owner and the server in the guarded delete', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration()]);
    mockTxReadLimit.mockResolvedValue([buildDiscordIntegration()]);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(uninstallApp(owner)).resolves.toEqual({ success: true });

    const predicate = mockDeleteWhere.mock.calls[0][0];
    const rendered = new PgDialect().sqlToQuery(predicate as SQL);
    // The server id appears twice: once per identifier column the predicate
    // covers.
    expect(rendered.params.filter(param => param === guildId)).toHaveLength(2);
    expect(rendered.params).toContain(owner.id);
    expect(rendered.sql).toContain('"platform_installation_id"');
    expect(rendered.sql).toContain('"platform_account_id"');
  });

  it('follows the row to the server it moved to before removing anything', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration()]);
    mockTxReadLimit
      .mockResolvedValueOnce([buildDiscordIntegration({ platform_installation_id: movedGuildId })])
      .mockResolvedValueOnce([buildDiscordIntegration({ platform_installation_id: movedGuildId })]);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(uninstallApp(owner)).resolves.toEqual({ success: true });

    expect(mockTransaction).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://discord.com/api/v10/users/%40me/guilds/${movedGuildId}`,
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);

    const rendered = new PgDialect().sqlToQuery(mockDeleteWhere.mock.calls[0][0] as SQL);
    expect(rendered.params).toContain(movedGuildId);
    expect(rendered.params).not.toContain(guildId);

    // The second section names the server the row recorded, not the one the
    // pre-read saw.
    const serverLocks = mockTxExecute.mock.calls
      .map(([statement]) => statementText(statement))
      .filter(
        text =>
          text.includes('pg_advisory_xact_lock') && !text.includes('integration-installation-owner')
      );
    expect(serverLocks).toHaveLength(2);
    expect(serverLocks[0]).toContain(`integration-installation:discord:${guildId}`);
    expect(serverLocks[1]).toContain(`integration-installation:discord:${movedGuildId}`);
  });

  it('stops following a row that is still moving and reports the retryable answer', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration()]);
    mockTxReadLimit
      .mockResolvedValueOnce([buildDiscordIntegration({ platform_installation_id: movedGuildId })])
      .mockResolvedValueOnce([
        buildDiscordIntegration({ platform_installation_id: stillMovingGuildId }),
      ]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(uninstallApp(owner)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: DISCORD_DISCONNECT_UNCONFIRMED_MESSAGE,
    });

    expect(mockTransaction).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('takes the owner lock and the server lock before lowering the statement budget', async () => {
    mockLimit.mockResolvedValue([buildDiscordIntegration()]);
    mockTxReadLimit.mockResolvedValue([buildDiscordIntegration()]);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(uninstallApp(owner)).resolves.toEqual({ success: true });

    const ran = mockTxExecute.mock.calls.map(([statement]) => statementText(statement));
    const lockIndexes = ran
      .map((text, index) => (text.includes('pg_advisory_xact_lock') ? index : -1))
      .filter(index => index >= 0);
    expect(lockIndexes).toHaveLength(2);
    expect(ran[lockIndexes[0]]).toContain(
      `integration-installation-owner:discord:user:${owner.id}`
    );
    expect(ran[lockIndexes[1]]).toContain(`integration-installation:discord:${guildId}`);

    const budgetIndex = ran.findIndex(text => text.includes('statement_timeout'));
    expect(budgetIndex).toBeGreaterThanOrEqual(0);
    expect(budgetIndex).toBeGreaterThan(lockIndexes[1]);
    expect(ran[budgetIndex]).toContain(`'${INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS}ms'`);
    expect(ran.some(text => text.includes(`lock_timeout = '${INSTALLATION_LOCK_WAIT_MS}ms'`))).toBe(
      true
    );
  });

  it('budgets the section below the lock wait', () => {
    // Three statements run inside the locks: the row read, the ownership
    // check, and the delete.
    expect(
      3 * INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS + DISCORD_DISCONNECT_REMOVAL_TIMEOUT_MS
    ).toBeLessThan(INSTALLATION_LOCK_WAIT_MS);
  });
});
