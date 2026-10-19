import { describe, test, expect } from 'vitest';
import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_mcp_servers,
  agent_environment_profiles,
} from '@kilocode/db/schema';
import { generateKeyPairSync } from 'node:crypto';
import {
  createMcpServer,
  updateMcpServer,
  mcpServerFullInputSchema,
  type StoredMcpSecretValue,
} from './profile-mcp-service';
import { MASKED_SECRET_VALUE, type ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const SERVER_ID = '22222222-2222-4222-8222-222222222222';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_KEY = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString(
  'base64'
);

function storedEnvelope(value: string): StoredMcpSecretValue {
  return {
    encryptedData: Buffer.from(`stored:${value}`).toString('base64'),
    encryptedDEK: Buffer.from(`dek:${value}`).toString('base64'),
    algorithm: 'rsa-aes-256-gcm' as const,
    version: 1 as const,
  };
}

/**
 * Minimal db stand-in: one stored MCP server row, capture of update and
 * insert payloads. Mirrors the thenable select / update chain style used by
 * profile-instructions-service.test.ts.
 */
function createMcpServiceDb(options: {
  type: 'local' | 'remote';
  command?: string[];
  url?: string;
  environment?: Record<string, StoredMcpSecretValue>;
  headers?: Record<string, StoredMcpSecretValue>;
}) {
  const state = {
    updateSets: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
  };

  const mcpRow = {
    id: SERVER_ID,
    profile_id: PROFILE_ID,
    name: 'test-server',
    type: options.type,
    enabled: true,
    timeout: null,
    config: {
      ...(options.type === 'local'
        ? { command: options.command ?? ['node', 'server.js'] }
        : { url: options.url ?? 'https://mcp.example.com' }),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    },
  };

  function selectChain(rows: unknown[]) {
    const result = {
      from: () => result,
      where: () => result,
      orderBy: () => result,
      limit: () => result,
      for: () => result,
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return result;
  }

  const db = {
    select() {
      return {
        from(table: unknown) {
          // Ownership check selects the profile table; return the profile row.
          if (table === agent_environment_profiles) {
            return selectChain([{ id: PROFILE_ID, owned_by_user_id: OWNER.id }]);
          }
          if (table === agent_environment_profile_mcp_servers) {
            return selectChain([mcpRow]);
          }
          throw new Error('MCP service test db: unexpected table');
        },
      };
    },
    update(table: unknown) {
      if (table !== agent_environment_profile_mcp_servers) {
        throw new Error('MCP service test db: unexpected table');
      }
      return {
        set(values: Record<string, unknown>) {
          state.updateSets.push(values);
          return {
            where: () => Promise.resolve(),
          };
        },
      };
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          state.inserted.push(values);
          return {
            returning: () => Promise.resolve([{ id: SERVER_ID }]),
          };
        },
      };
    },
  } as unknown as WorkerDb;

  return { db, state };
}

function parseInput(input: unknown) {
  return mcpServerFullInputSchema.parse(input);
}

describe('updateMcpServer secret reuse', () => {
  test('rejects masked header values when the remote url changes', async () => {
    const stored = storedEnvelope('token-1');
    const { db, state } = createMcpServiceDb({
      type: 'remote',
      url: 'https://mcp.example.com',
      headers: { Authorization: stored },
    });

    await expect(
      updateMcpServer(
        db,
        PUBLIC_KEY,
        PROFILE_ID,
        SERVER_ID,
        parseInput({
          name: 'test-server',
          type: 'remote',
          config: {
            url: 'https://attacker.example.com',
            headers: { Authorization: MASKED_SECRET_VALUE },
          },
        }),
        OWNER
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(state.updateSets).toHaveLength(0);
  });

  test('rejects masked environment values when the local command changes', async () => {
    const stored = storedEnvelope('secret-1');
    const { db, state } = createMcpServiceDb({
      type: 'local',
      command: ['node', 'server.js'],
      environment: { API_KEY: stored },
    });

    await expect(
      updateMcpServer(
        db,
        PUBLIC_KEY,
        PROFILE_ID,
        SERVER_ID,
        parseInput({
          name: 'test-server',
          type: 'local',
          config: {
            command: ['python', 'server.py'],
            environment: { API_KEY: MASKED_SECRET_VALUE },
          },
        }),
        OWNER
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(state.updateSets).toHaveLength(0);
  });

  test('rejects masked environment values when any argv element changes', async () => {
    const stored = storedEnvelope('secret-1');
    const { db } = createMcpServiceDb({
      type: 'local',
      command: ['node', 'server.js', '--port', '3000'],
      environment: { API_KEY: stored },
    });

    await expect(
      updateMcpServer(
        db,
        PUBLIC_KEY,
        PROFILE_ID,
        SERVER_ID,
        parseInput({
          name: 'test-server',
          type: 'local',
          config: {
            command: ['node', 'server.js', '--port', '3001'],
            environment: { API_KEY: MASKED_SECRET_VALUE },
          },
        }),
        OWNER
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('rejects masked values when the server type changes', async () => {
    const stored = storedEnvelope('secret-1');
    const { db } = createMcpServiceDb({
      type: 'local',
      command: ['node', 'server.js'],
      environment: { API_KEY: stored },
    });

    await expect(
      updateMcpServer(
        db,
        PUBLIC_KEY,
        PROFILE_ID,
        SERVER_ID,
        parseInput({
          name: 'test-server',
          type: 'remote',
          config: {
            url: 'https://mcp.example.com',
            headers: { Authorization: MASKED_SECRET_VALUE },
          },
        }),
        OWNER
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('keeps stored header envelopes when the remote url is unchanged', async () => {
    const stored = storedEnvelope('token-1');
    const { db, state } = createMcpServiceDb({
      type: 'remote',
      url: 'https://mcp.example.com',
      headers: { Authorization: stored },
    });

    await updateMcpServer(
      db,
      PUBLIC_KEY,
      PROFILE_ID,
      SERVER_ID,
      parseInput({
        name: 'renamed-server',
        type: 'remote',
        config: {
          url: 'https://mcp.example.com',
          headers: { Authorization: MASKED_SECRET_VALUE },
        },
      }),
      OWNER
    );

    expect(state.updateSets).toHaveLength(1);
    const config = state.updateSets[0]!.config as {
      url: string;
      headers?: Record<string, StoredMcpSecretValue>;
    };
    expect(config.url).toBe('https://mcp.example.com');
    expect(config.headers?.Authorization).toEqual(stored);
  });

  test('keeps stored environment envelopes when the local command is unchanged', async () => {
    const stored = storedEnvelope('secret-1');
    const { db, state } = createMcpServiceDb({
      type: 'local',
      command: ['node', 'server.js'],
      environment: { API_KEY: stored },
    });

    await updateMcpServer(
      db,
      PUBLIC_KEY,
      PROFILE_ID,
      SERVER_ID,
      parseInput({
        name: 'renamed-server',
        type: 'local',
        config: {
          command: ['node', 'server.js'],
          environment: { API_KEY: MASKED_SECRET_VALUE },
        },
      }),
      OWNER
    );

    expect(state.updateSets).toHaveLength(1);
    const config = state.updateSets[0]!.config as {
      command: string[];
      environment?: Record<string, StoredMcpSecretValue>;
    };
    expect(config.command).toEqual(['node', 'server.js']);
    expect(config.environment?.API_KEY).toEqual(stored);
  });

  test('encrypts fresh values when the destination changes', async () => {
    const { db, state } = createMcpServiceDb({
      type: 'remote',
      url: 'https://mcp.example.com',
      headers: { Authorization: storedEnvelope('token-1') },
    });

    await updateMcpServer(
      db,
      PUBLIC_KEY,
      PROFILE_ID,
      SERVER_ID,
      parseInput({
        name: 'test-server',
        type: 'remote',
        config: {
          url: 'https://other.example.com',
          headers: { Authorization: 'fresh-token' },
        },
      }),
      OWNER
    );

    expect(state.updateSets).toHaveLength(1);
    const config = state.updateSets[0]!.config as {
      url: string;
      headers?: Record<string, StoredMcpSecretValue>;
    };
    expect(config.url).toBe('https://other.example.com');
    const header = config.headers?.Authorization;
    expect(header).toBeDefined();
    expect(header).not.toEqual(storedEnvelope('token-1'));
    expect(header).toMatchObject({
      algorithm: 'rsa-aes-256-gcm',
      version: 1,
    });
    expect(typeof header === 'object' && header.encryptedData.length).toBeGreaterThan(0);
  });
});

describe('createMcpServer with placeholder values', () => {
  test('encrypts placeholder input as a literal on create', async () => {
    const { db, state } = createMcpServiceDb({ type: 'remote' });

    await createMcpServer(
      db,
      PUBLIC_KEY,
      PROFILE_ID,
      parseInput({
        name: 'new-server',
        type: 'remote',
        config: {
          url: 'https://mcp.example.com',
          headers: { Authorization: MASKED_SECRET_VALUE },
        },
      }),
      OWNER
    );

    expect(state.inserted).toHaveLength(1);
    const config = state.inserted[0]!.config as {
      headers?: Record<string, StoredMcpSecretValue>;
    };
    const header = config.headers?.Authorization;
    expect(header).toMatchObject({ algorithm: 'rsa-aes-256-gcm', version: 1 });
  });
});
