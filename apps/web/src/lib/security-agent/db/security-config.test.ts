import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { agent_configs, security_agent_commands, type User } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';

const mockEnqueueBacklogFindings = jest.fn<(params: { tx?: unknown }) => Promise<number>>();
const mockResetOwnerAutoAnalysisEnabledAt =
  jest.fn<(owner: unknown, tx?: unknown) => Promise<void>>();

jest.mock('./security-analysis', () => ({
  setOwnerAutoAnalysisEnabledAtNow: jest.fn(),
  resetOwnerAutoAnalysisEnabledAt: mockResetOwnerAutoAnalysisEnabledAt,
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
  await db.delete(security_agent_commands).where(sql`true`);
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

  it('records the activation boundary in the same transaction as the enqueue', async () => {
    mockEnqueueBacklogFindings.mockResolvedValue(0);

    await saveSecurityAgentConfigWithRevision({
      owner: owner(),
      config: { auto_analysis_enabled: true },
      createdBy: user.id,
      expectedRevision: null,
      enqueueAnalysis: { owner: { userId: user.id }, minSeverity: 'high' },
    });

    // Same tx object for both: no worker can claim a queued backlog row before
    // the activation boundary it is judged against is committed.
    const enqueueTx = mockEnqueueBacklogFindings.mock.calls[0]?.[0].tx;
    expect(enqueueTx).toBeDefined();
    expect(mockResetOwnerAutoAnalysisEnabledAt).toHaveBeenCalledTimes(1);
    expect(mockResetOwnerAutoAnalysisEnabledAt.mock.calls[0]?.[1]).toBe(enqueueTx);
  });

  it('skips the include-existing remediation command when approval is required', async () => {
    const outcome = await saveSecurityAgentConfigWithRevision({
      owner: owner(),
      config: { auto_remediation_enabled: true, auto_remediation_require_approval: true },
      createdBy: user.id,
      expectedRevision: null,
      enqueueRemediation: { owner: { userId: user.id } },
    });

    expect(outcome.existingRemediationCommandId).toBeUndefined();
    const commands = await db
      .select({ id: security_agent_commands.id })
      .from(security_agent_commands)
      .where(eq(security_agent_commands.owned_by_user_id, user.id));
    expect(commands).toHaveLength(0);
  });

  it('creates the include-existing remediation command when approval is not required', async () => {
    const outcome = await saveSecurityAgentConfigWithRevision({
      owner: owner(),
      config: { auto_remediation_enabled: true, auto_remediation_require_approval: false },
      createdBy: user.id,
      expectedRevision: null,
      enqueueRemediation: { owner: { userId: user.id } },
    });

    expect(outcome.existingRemediationCommandId).toBeDefined();
    const commands = await db
      .select({ id: security_agent_commands.id, command_type: security_agent_commands.command_type })
      .from(security_agent_commands)
      .where(eq(security_agent_commands.owned_by_user_id, user.id));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command_type).toBe('apply_auto_remediation');
  });
});
