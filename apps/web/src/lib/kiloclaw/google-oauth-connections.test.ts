jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(),
    update: jest.fn(),
    insert: jest.fn(),
  },
}));

jest.mock('@/lib/config.server', () => ({
  GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
}));

jest.mock('@/lib/encryption', () => ({
  encryptWithSymmetricKey: jest.fn((value: string) => `enc:${value}`),
}));

import { db } from '@/lib/drizzle';
import { upsertKiloClawGoogleOAuthConnection } from './google-oauth-connections';

type MockDb = {
  select: jest.Mock;
  update: jest.Mock;
  insert: jest.Mock;
};

describe('upsertKiloClawGoogleOAuthConnection grants_by_source merge', () => {
  const mockDb = db as unknown as MockDb;

  let selectedRows: unknown[] = [];
  let selectedRowsQueue: unknown[][] = [];
  const updateSetCalls: Array<Record<string, unknown>> = [];
  const insertValuesCalls: Array<Record<string, unknown>> = [];
  const insertOnConflictCalls: Array<{ target: unknown; set: Record<string, unknown> }> = [];

  beforeEach(() => {
    selectedRows = [];
    selectedRowsQueue = [];
    updateSetCalls.length = 0;
    insertValuesCalls.length = 0;
    insertOnConflictCalls.length = 0;

    mockDb.select.mockReset();
    mockDb.select.mockImplementation(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest
            .fn()
            .mockImplementation(() => Promise.resolve(selectedRowsQueue.shift() ?? selectedRows)),
        })),
      })),
    }));

    mockDb.update.mockReset();
    mockDb.update.mockImplementation(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return {
          where: jest.fn().mockResolvedValue(undefined),
        };
      }),
    }));

    mockDb.insert.mockReset();
    mockDb.insert.mockImplementation(() => ({
      values: jest.fn((values: Record<string, unknown>) => {
        insertValuesCalls.push(values);
        return {
          onConflictDoUpdate: jest.fn(
            (config: { target: unknown; set: Record<string, unknown> }) => {
              insertOnConflictCalls.push(config);
              return Promise.resolve(undefined);
            }
          ),
        };
      }),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('merges legacy and oauth capabilities when existing profile is legacy', async () => {
    selectedRows = [
      {
        id: 'row-1',
        instance_id: 'instance-1',
        credential_profile: 'legacy',
        refresh_token_encrypted: 'enc:old-refresh',
        capabilities: ['gmail_read'],
        grants_by_source: null,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        status: 'active',
        connected_at: '2026-04-01T00:00:00.000Z',
      },
    ];

    const result = await upsertKiloClawGoogleOAuthConnection({
      instanceId: 'instance-1',
      accountEmail: 'user@example.com',
      accountSubject: 'subject-1',
      refreshToken: 'new-refresh',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      capabilities: ['calendar_read'],
    });

    expect(updateSetCalls).toHaveLength(1);
    expect(updateSetCalls[0]).toEqual(
      expect.objectContaining({
        credential_profile: 'kilo_owned',
        grants_by_source: {
          legacy: ['gmail_read'],
          oauth: ['calendar_read'],
        },
        capabilities: ['calendar_read', 'gmail_read'],
      })
    );
    expect(result.capabilities).toEqual(['calendar_read', 'gmail_read']);
    expect(insertValuesCalls).toHaveLength(0);
  });

  it('preserves legacy grants when updating an existing kilo_owned connection', async () => {
    selectedRows = [
      {
        id: 'row-2',
        instance_id: 'instance-2',
        credential_profile: 'kilo_owned',
        refresh_token_encrypted: 'enc:existing-refresh',
        capabilities: ['calendar_read', 'drive_read', 'gmail_read'],
        grants_by_source: {
          legacy: ['drive_read', 'gmail_read'],
          oauth: ['calendar_read'],
        },
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        status: 'active',
        connected_at: '2026-04-01T00:00:00.000Z',
      },
    ];

    const result = await upsertKiloClawGoogleOAuthConnection({
      instanceId: 'instance-2',
      accountEmail: 'user@example.com',
      accountSubject: 'subject-2',
      refreshToken: null,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      capabilities: ['calendar_read'],
    });

    expect(updateSetCalls).toHaveLength(1);
    expect(updateSetCalls[0]).toEqual(
      expect.objectContaining({
        grants_by_source: {
          legacy: ['drive_read', 'gmail_read'],
          oauth: ['calendar_read'],
        },
        capabilities: ['calendar_read', 'drive_read', 'gmail_read'],
      })
    );
    expect(result.capabilities).toEqual(['calendar_read', 'drive_read', 'gmail_read']);
    expect(insertValuesCalls).toHaveLength(0);
  });

  it('merges oauth grants with winner row grants after conflict-safe insert path', async () => {
    selectedRows = [];
    selectedRowsQueue = [
      [],
      [
        {
          id: 'row-race',
          instance_id: 'instance-race',
          credential_profile: 'legacy',
          refresh_token_encrypted: 'enc:winner-refresh',
          capabilities: ['gmail_read'],
          grants_by_source: { legacy: ['gmail_read'] },
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          status: 'active',
          connected_at: '2026-04-01T00:00:00.000Z',
        },
      ],
    ];

    const result = await upsertKiloClawGoogleOAuthConnection({
      instanceId: 'instance-race',
      accountEmail: 'user@example.com',
      accountSubject: 'subject-race',
      refreshToken: 'refresh-race',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      capabilities: ['calendar_read'],
    });

    expect(insertValuesCalls.length).toBeGreaterThan(0);
    expect(insertOnConflictCalls.length).toBeGreaterThan(0);
    expect(insertOnConflictCalls[0]).toEqual(
      expect.objectContaining({
        target: expect.anything(),
        set: expect.objectContaining({
          credential_profile: 'kilo_owned',
          status: 'active',
          last_error: null,
        }),
      })
    );
    expect(insertOnConflictCalls[0].set).not.toHaveProperty('grants_by_source');
    expect(insertOnConflictCalls[0].set).not.toHaveProperty('capabilities');
    expect(updateSetCalls).toContainEqual(
      expect.objectContaining({
        grants_by_source: {
          legacy: ['gmail_read'],
          oauth: ['calendar_read'],
        },
        capabilities: ['calendar_read', 'gmail_read'],
      })
    );
    expect(result.capabilities).toEqual(['calendar_read', 'gmail_read']);
  });
});
