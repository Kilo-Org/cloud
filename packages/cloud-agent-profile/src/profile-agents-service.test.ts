import { describe, expect, test } from 'vitest';
import type { WorkerDb } from '@kilocode/db';
import { createLimitTestDb, TEST_PROFILE_ID } from './profile-limit-test-db';
import {
  MAX_PROFILE_AGENTS,
  createAgent,
  getAgentsForSession,
  listAgentsForProfile,
  type AgentCreateInput,
} from './profile-agents-service';
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

describe('getAgentsForSession', () => {
  // The limit fake models inserts and locks, not this read, so a fixed row list is enough here.
  const storedRow = (slug: string, name: string, config: Record<string, unknown> = {}) => ({
    id: `agent_${slug}`,
    profile_id: TEST_PROFILE_ID,
    slug,
    name,
    config,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () =>
            Promise.resolve([
              storedRow('reviewer', 'Reviewer'),
              storedRow('explore', 'Explore', { prompt: 'x' }),
              storedRow('general', 'General'),
            ]),
        }),
      }),
    }),
  } as unknown as WorkerDb;

  test('omits stored agents whose id belongs to the CLI and names them', async () => {
    await expect(getAgentsForSession(db, TEST_PROFILE_ID)).resolves.toEqual({
      agents: [{ slug: 'reviewer', name: 'Reviewer', config: {} }],
      skippedSlugs: ['explore', 'general'],
    });
  });

  test('keeps CLI-owned ids visible to the profile editor', async () => {
    const agents = await listAgentsForProfile(db, TEST_PROFILE_ID);

    expect(agents.map(agent => ({ slug: agent.slug, config: agent.config }))).toEqual([
      { slug: 'reviewer', config: {} },
      { slug: 'explore', config: { prompt: 'x' } },
      { slug: 'general', config: {} },
    ]);
  });
});
