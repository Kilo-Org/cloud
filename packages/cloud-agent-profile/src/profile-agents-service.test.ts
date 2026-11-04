import { describe, expect, test } from 'vitest';
import { createLimitTestDb, TEST_PROFILE_ID } from './profile-limit-test-db';
import { MAX_PROFILE_AGENTS, createAgent, type AgentCreateInput } from './profile-agents-service';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };

function agentInput(slug: string): AgentCreateInput {
  return { slug, name: slug, config: {} };
}

describe('createAgent cap enforcement', () => {
  test('stores an agent while the profile is below the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_AGENTS - 1);

    await expect(createAgent(db, TEST_PROFILE_ID, agentInput('reviewer'), OWNER)).resolves.toEqual({
      id: expect.any(String),
    });
    expect(state.rowCount).toBe(MAX_PROFILE_AGENTS);
    expect(state.lockCalls).toBe(1);
  });

  test('rejects a create at the cap without inserting', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_AGENTS);

    await expect(
      createAgent(db, TEST_PROFILE_ID, agentInput('reviewer'), OWNER)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(state.rowCount).toBe(MAX_PROFILE_AGENTS);
    expect(state.lockCalls).toBe(1);
  });

  test('keeps concurrent creates within the per-profile cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_AGENTS - 1);

    const results = await Promise.allSettled([
      createAgent(db, TEST_PROFILE_ID, agentInput('first'), OWNER),
      createAgent(db, TEST_PROFILE_ID, agentInput('second'), OWNER),
    ]);

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(state.rowCount).toBe(MAX_PROFILE_AGENTS);
    expect(state.lockCalls).toBe(2);
  });
});
