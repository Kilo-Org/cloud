import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { agent_configs, type User } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';

const mockEnqueueBacklogFindings = jest.fn<() => Promise<number>>();

jest.mock('./security-analysis', () => ({
  setOwnerAutoAnalysisEnabledAtNow: jest.fn(),
  resetOwnerAutoAnalysisEnabledAt: jest.fn(),
  enqueueBacklogFindings: mockEnqueueBacklogFindings,
}));

import type * as securityConfigModule from './security-config';

let saveSecurityAgentConfigWithRevision: typeof securityConfigModule.saveSecurityAgentConfigWithRevision;

beforeAll(async () => {
  ({ saveSecurityAgentConfigWithRevision } = await import('./security-config'));
});

let user: User;

beforeEach(async () => {
  jest.clearAllMocks();
  user = await insertTestUser();
  await db.delete(agent_configs).where(sql`true`);
});

function owner() {
  return { type: 'user' as const, id: user.id, userId: user.id };
}

async function readRevision(): Promise<number | null> {
  const [row] = await db
    .select({ config_revision: agent_configs.config_revision })
    .from(agent_configs)
    .where(eq(agent_configs.owned_by_user_id, user.id));
  return row?.config_revision ?? null;
}

describe('saveSecurityAgentConfigWithRevision', () => {
  it('writes config_revision 1 on the first insert', async () => {
    const outcome = await saveSecurityAgentConfigWithRevision({
      owner: owner(),
      config: { auto_analysis_enabled: true },
      createdBy: user.id,
      expectedRevision: null,
    });

    expect(outcome.newRevision).toBe(1);
    expect(await readRevision()).toBe(1);
  });

  it('increments the revision on an update with the current revision', async () => {
    await saveSecurityAgentConfigWithRevision({
      owner: owner(),
      config: { auto_analysis_enabled: true },
      createdBy: user.id,
      expectedRevision: null,
    });

    const outcome = await saveSecurityAgentConfigWithRevision({
      owner: owner(),
      config: { auto_analysis_enabled: false },
      createdBy: user.id,
      expectedRevision: 1,
    });

    expect(outcome.newRevision).toBe(2);
    expect(await readRevision()).toBe(2);
  });

  it('conflicts on a stale revision and leaves the config unchanged', async () => {
    await saveSecurityAgentConfigWithRevision({
      owner: owner(),
      config: { auto_analysis_enabled: true },
      createdBy: user.id,
      expectedRevision: null,
    });
    await saveSecurityAgentConfigWithRevision({
      owner: owner(),
      config: { auto_analysis_enabled: false },
      createdBy: user.id,
      expectedRevision: 1,
    });

    // A second writer still holds revision 1, so its save must lose.
    await expect(
      saveSecurityAgentConfigWithRevision({
        owner: owner(),
        config: { auto_analysis_enabled: true },
        createdBy: user.id,
        expectedRevision: 1,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await readRevision()).toBe(2);
  });

  it('conflicts when a first insert races an already-existing row', async () => {
    await saveSecurityAgentConfigWithRevision({
      owner: owner(),
      config: { auto_analysis_enabled: true },
      createdBy: user.id,
      expectedRevision: null,
    });

    await expect(
      saveSecurityAgentConfigWithRevision({
        owner: owner(),
        config: { auto_analysis_enabled: false },
        createdBy: user.id,
        expectedRevision: null,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rolls back the config write when the backlog enqueue throws', async () => {
    mockEnqueueBacklogFindings.mockRejectedValue(new Error('database unavailable'));

    await expect(
      saveSecurityAgentConfigWithRevision({
        owner: owner(),
        config: { auto_analysis_enabled: true },
        createdBy: user.id,
        expectedRevision: null,
        enqueueAnalysis: { owner: { userId: user.id }, minSeverity: 'high' },
      })
    ).rejects.toThrow('database unavailable');

    // The config write was rolled back with the enqueue failure.
    expect(await readRevision()).toBeNull();
  });
});
