import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { WorkerDb } from './client';
import {
  security_agent_commands,
  type SecurityAgentCommand,
  type SecurityAgentCommandOrigin,
  type SecurityAgentCommandStatus,
  type SecurityAgentCommandType,
} from './schema';

export type SecurityAgentCommandOwner = { type: 'org'; id: string } | { type: 'user'; id: string };

type SecurityAgentCommandDb = Pick<WorkerDb, 'delete' | 'insert' | 'select' | 'update'>;

export type CreateSecurityAgentCommandInput = {
  id?: string;
  commandType: SecurityAgentCommandType;
  origin: SecurityAgentCommandOrigin;
  owner: SecurityAgentCommandOwner;
  findingId?: string;
  repoFullName?: string;
};

export type TransitionSecurityAgentCommandInput = {
  commandId: string;
  fromStatuses: SecurityAgentCommandStatus[];
  status: SecurityAgentCommandStatus;
  resultCode?: string | null;
  lastErrorRedacted?: string | null;
};

export type SecurityAgentCommandTransitionOutcome =
  | { transitioned: true; command: SecurityAgentCommand }
  | { transitioned: false; command: SecurityAgentCommand | null };

export function isTerminalSecurityAgentCommandTransitionOutcome(
  outcome: SecurityAgentCommandTransitionOutcome
): outcome is { transitioned: false; command: SecurityAgentCommand } {
  return (
    !outcome.transitioned && Boolean(outcome.command && isTerminalStatus(outcome.command.status))
  );
}

export function requireSecurityAgentCommandTransitionOrTerminal(
  outcome: SecurityAgentCommandTransitionOutcome,
  transition: 'running' | 'terminal'
): 'transitioned' | 'terminal' {
  if (outcome.transitioned) return 'transitioned';
  if (isTerminalSecurityAgentCommandTransitionOutcome(outcome)) return 'terminal';
  throw new Error(`Security Agent command ${transition} transition rejected`);
}

function ownerValues(owner: SecurityAgentCommandOwner) {
  return {
    owned_by_organization_id: owner.type === 'org' ? owner.id : null,
    owned_by_user_id: owner.type === 'user' ? owner.id : null,
  };
}

function ownerWhere(owner: SecurityAgentCommandOwner) {
  return owner.type === 'org'
    ? eq(security_agent_commands.owned_by_organization_id, owner.id)
    : eq(security_agent_commands.owned_by_user_id, owner.id);
}

function isTerminalStatus(status: SecurityAgentCommandStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'no_op';
}

export async function createSecurityAgentCommand(
  db: SecurityAgentCommandDb,
  input: CreateSecurityAgentCommandInput
): Promise<SecurityAgentCommand> {
  const [command] = await db
    .insert(security_agent_commands)
    .values({
      id: input.id,
      command_type: input.commandType,
      origin: input.origin,
      ...ownerValues(input.owner),
      finding_id: input.findingId,
      repo_full_name: input.repoFullName,
      status: 'accepted',
    })
    .returning();

  if (!command) throw new Error('Failed to create security agent command');
  return command;
}

export async function transitionSecurityAgentCommand(
  db: SecurityAgentCommandDb,
  input: TransitionSecurityAgentCommandInput
): Promise<SecurityAgentCommand | null> {
  if (input.fromStatuses.length === 0) return null;

  const [command] = await db
    .update(security_agent_commands)
    .set({
      status: input.status,
      result_code: input.resultCode,
      last_error_redacted: input.lastErrorRedacted,
      started_at:
        input.status === 'running'
          ? sql`COALESCE(${security_agent_commands.started_at}, now())`
          : undefined,
      completed_at: isTerminalStatus(input.status) ? sql`now()` : undefined,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(security_agent_commands.id, input.commandId),
        inArray(security_agent_commands.status, input.fromStatuses)
      )
    )
    .returning();

  return command ?? null;
}

export async function transitionSecurityAgentCommandWithCurrentState(
  db: SecurityAgentCommandDb,
  input: TransitionSecurityAgentCommandInput
): Promise<SecurityAgentCommandTransitionOutcome> {
  const transitioned = await transitionSecurityAgentCommand(db, input);
  if (transitioned) return { transitioned: true, command: transitioned };

  const [command] = await db
    .select()
    .from(security_agent_commands)
    .where(eq(security_agent_commands.id, input.commandId))
    .limit(1);

  return { transitioned: false, command: command ?? null };
}

export async function markSecurityAgentCommandQueueAdmissionFailed(
  db: SecurityAgentCommandDb,
  commandId: string,
  lastErrorRedacted?: string
): Promise<SecurityAgentCommand | null> {
  return transitionSecurityAgentCommand(db, {
    commandId,
    fromStatuses: ['accepted'],
    status: 'failed',
    resultCode: 'QUEUE_ADMISSION_FAILED',
    lastErrorRedacted,
  });
}

export async function markSecurityAgentCommandRetriesExhausted(
  db: SecurityAgentCommandDb,
  commandId: string
): Promise<SecurityAgentCommandTransitionOutcome> {
  return transitionSecurityAgentCommandWithCurrentState(db, {
    commandId,
    fromStatuses: ['accepted', 'running'],
    status: 'failed',
    resultCode: 'QUEUE_RETRIES_EXHAUSTED',
    lastErrorRedacted: 'Queue command failed after maximum delivery attempts',
  });
}

export async function getSecurityAgentCommandForOwner(
  db: SecurityAgentCommandDb,
  owner: SecurityAgentCommandOwner,
  commandId: string
): Promise<SecurityAgentCommand | null> {
  const [command] = await db
    .select()
    .from(security_agent_commands)
    .where(and(eq(security_agent_commands.id, commandId), ownerWhere(owner)))
    .limit(1);

  return command ?? null;
}

export async function listActiveSecurityAgentCommandsForOwner(
  db: SecurityAgentCommandDb,
  owner: SecurityAgentCommandOwner,
  limit = 100
): Promise<SecurityAgentCommand[]> {
  return db
    .select()
    .from(security_agent_commands)
    .where(and(ownerWhere(owner), inArray(security_agent_commands.status, ['accepted', 'running'])))
    .orderBy(desc(security_agent_commands.created_at))
    .limit(limit);
}

export async function reconcileStaleSecurityAgentCommands(
  db: SecurityAgentCommandDb,
  input: { acceptedBefore: Date; runningBefore: Date }
): Promise<{ staleAccepted: SecurityAgentCommand[]; staleRunning: SecurityAgentCommand[] }> {
  const staleAccepted = await db
    .update(security_agent_commands)
    .set({
      status: 'failed',
      result_code: 'COMMAND_STALLED',
      last_error_redacted: 'Queue command did not start before reconciliation timeout',
      completed_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(security_agent_commands.status, 'accepted'),
        lt(security_agent_commands.updated_at, input.acceptedBefore.toISOString())
      )
    )
    .returning();

  const staleRunning = await db
    .update(security_agent_commands)
    .set({
      status: 'failed',
      result_code: 'COMMAND_STALLED',
      last_error_redacted: 'Queue command did not complete before reconciliation timeout',
      completed_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(security_agent_commands.status, 'running'),
        lt(security_agent_commands.updated_at, input.runningBefore.toISOString())
      )
    )
    .returning();

  return { staleAccepted, staleRunning };
}

export async function deleteRetainedSecurityAgentCommands(
  db: SecurityAgentCommandDb,
  terminalBefore: Date
): Promise<number> {
  const deleted = await db
    .delete(security_agent_commands)
    .where(
      and(
        inArray(security_agent_commands.status, ['succeeded', 'failed', 'no_op']),
        lt(security_agent_commands.updated_at, terminalBefore.toISOString())
      )
    )
    .returning({ id: security_agent_commands.id });

  return deleted.length;
}
