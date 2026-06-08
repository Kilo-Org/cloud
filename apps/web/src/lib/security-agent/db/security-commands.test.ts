import { db } from '@/lib/drizzle';
import {
  createSecurityAgentCommand,
  deleteRetainedSecurityAgentCommands,
  getSecurityAgentCommandForOwner,
  getSecurityAgentRepositorySyncState,
  listActiveSecurityAgentCommandsForOwner,
  reconcileStaleSecurityAgentCommands,
  recordSecurityAgentRepositorySyncFailure,
  recordSecurityAgentRepositorySyncSuccess,
  transitionSecurityAgentCommand,
} from '@kilocode/db';
import { kilocode_users, security_agent_commands } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('Security Agent command ledger', () => {
  afterEach(async () => {
    await db.delete(security_agent_commands).where(sql`true`);
    await db.delete(kilocode_users).where(sql`true`);
  });

  it('guards lifecycle transitions and owner-scoped lookup', async () => {
    const owner = await insertTestUser();
    const otherOwner = await insertTestUser();
    const command = await createSecurityAgentCommand(db, {
      commandType: 'sync',
      origin: 'manual',
      owner: { type: 'user', id: owner.id },
    });

    await expect(
      transitionSecurityAgentCommand(db, {
        commandId: command.id,
        fromStatuses: ['accepted'],
        status: 'running',
      })
    ).resolves.toMatchObject({ status: 'running' });
    await expect(
      transitionSecurityAgentCommand(db, {
        commandId: command.id,
        fromStatuses: ['running'],
        status: 'succeeded',
        resultCode: 'SYNC_COMPLETED',
      })
    ).resolves.toMatchObject({ status: 'succeeded', result_code: 'SYNC_COMPLETED' });
    await expect(
      transitionSecurityAgentCommand(db, {
        commandId: command.id,
        fromStatuses: ['accepted', 'running'],
        status: 'running',
      })
    ).resolves.toBeNull();
    await expect(
      getSecurityAgentCommandForOwner(db, { type: 'user', id: otherOwner.id }, command.id)
    ).resolves.toBeNull();
  });

  it('enforces exactly one owner', async () => {
    await expect(
      db.insert(security_agent_commands).values({ command_type: 'sync', origin: 'manual' })
    ).rejects.toMatchObject({ cause: { constraint: 'security_agent_commands_owner_check' } });
  });

  it('reconciles stale commands and deletes expired terminal rows', async () => {
    const owner = await insertTestUser();
    const accepted = await createSecurityAgentCommand(db, {
      commandType: 'start_analysis',
      origin: 'manual',
      owner: { type: 'user', id: owner.id },
    });
    const running = await createSecurityAgentCommand(db, {
      commandType: 'dismiss_finding',
      origin: 'manual',
      owner: { type: 'user', id: owner.id },
    });
    await transitionSecurityAgentCommand(db, {
      commandId: running.id,
      fromStatuses: ['accepted'],
      status: 'running',
    });
    await db
      .update(security_agent_commands)
      .set({ updated_at: sql`now() - interval '2 hours'` })
      .where(eq(security_agent_commands.id, accepted.id));
    await db
      .update(security_agent_commands)
      .set({ updated_at: sql`now() - interval '2 hours'` })
      .where(eq(security_agent_commands.id, running.id));

    const reconciliation = await reconcileStaleSecurityAgentCommands(db, {
      acceptedBefore: new Date(Date.now() - 60 * 60 * 1000),
      runningBefore: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(reconciliation.staleAccepted.map(command => command.id)).toContain(accepted.id);
    expect(reconciliation.staleRunning.map(command => command.id)).toContain(running.id);

    await db
      .update(security_agent_commands)
      .set({ updated_at: sql`now() - interval '31 days'` })
      .where(eq(security_agent_commands.id, accepted.id));
    await expect(
      deleteRetainedSecurityAgentCommands(db, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    ).resolves.toBeGreaterThanOrEqual(1);
  });

  it('lists active commands and clean-repository freshness for only requested owner', async () => {
    const owner = await insertTestUser();
    const otherOwner = await insertTestUser();
    const command = await createSecurityAgentCommand(db, {
      commandType: 'sync',
      origin: 'dashboard_refresh',
      owner: { type: 'user', id: owner.id },
    });
    await recordSecurityAgentRepositorySyncSuccess(db, {
      owner: { type: 'user', id: owner.id },
      repoFullName: 'kilo/clean-repository',
    });
    await recordSecurityAgentRepositorySyncFailure(db, {
      owner: { type: 'user', id: owner.id },
      repoFullName: 'kilo/failed-repository',
      failureCode: 'SYNC_FAILED',
    });

    await expect(
      listActiveSecurityAgentCommandsForOwner(db, { type: 'user', id: owner.id })
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: command.id })]));
    await expect(
      listActiveSecurityAgentCommandsForOwner(db, { type: 'user', id: otherOwner.id })
    ).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: command.id })]));
    await expect(
      getSecurityAgentRepositorySyncState(
        db,
        { type: 'user', id: owner.id },
        'kilo/clean-repository'
      )
    ).resolves.toMatchObject({ last_failure_code: null, last_succeeded_at: expect.any(String) });
    await expect(
      getSecurityAgentRepositorySyncState(
        db,
        { type: 'user', id: otherOwner.id },
        'kilo/clean-repository'
      )
    ).resolves.toBeNull();
    await expect(
      getSecurityAgentRepositorySyncState(
        db,
        { type: 'user', id: owner.id },
        'kilo/failed-repository'
      )
    ).resolves.toMatchObject({ last_failure_code: 'SYNC_FAILED' });
  });
});
