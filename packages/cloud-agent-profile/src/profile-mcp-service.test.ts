import { describe, expect, test } from 'vitest';
import {
  MAX_PROFILE_MCP_SERVERS,
  createMcpServer,
  type McpServerInput,
} from './profile-mcp-service';
import { createLimitTestDb, TEST_PROFILE_ID } from './profile-limit-test-db';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };
const PUBLIC_KEY = 'unused-in-this-test';

function mcpServerInput(name: string): McpServerInput {
  return { name, type: 'remote', config: { url: `https://mcp.example.com/${name}` } };
}

describe('createMcpServer cap enforcement', () => {
  test('stores a server while the profile is below the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_MCP_SERVERS - 1);

    await expect(
      createMcpServer(db, PUBLIC_KEY, TEST_PROFILE_ID, mcpServerInput('docs'), OWNER)
    ).resolves.toEqual({ id: expect.any(String) });
    expect(state.rowCount).toBe(MAX_PROFILE_MCP_SERVERS);
    expect(state.lockCalls).toBe(1);
  });

  test('rejects a create at the cap without inserting', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_MCP_SERVERS);

    await expect(
      createMcpServer(db, PUBLIC_KEY, TEST_PROFILE_ID, mcpServerInput('docs'), OWNER)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(state.rowCount).toBe(MAX_PROFILE_MCP_SERVERS);
    expect(state.lockCalls).toBe(1);
  });

  test('keeps concurrent creates within the per-profile cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_MCP_SERVERS - 1);

    const results = await Promise.allSettled([
      createMcpServer(db, PUBLIC_KEY, TEST_PROFILE_ID, mcpServerInput('first'), OWNER),
      createMcpServer(db, PUBLIC_KEY, TEST_PROFILE_ID, mcpServerInput('second'), OWNER),
    ]);

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(state.rowCount).toBe(MAX_PROFILE_MCP_SERVERS);
    expect(state.lockCalls).toBe(2);
  });
});
