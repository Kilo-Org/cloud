import { and, eq, isNotNull } from 'drizzle-orm';
import type { WorkerDb } from './client';
import {
  security_agent_repository_sync_state,
  type SecurityAgentRepositorySyncState,
} from './schema';
import type { SecurityAgentCommandOwner } from './security-agent-command-repository';

type SecurityAgentRepositorySyncStateDb = Pick<WorkerDb, 'insert' | 'select'>;

function ownerWhere(owner: SecurityAgentCommandOwner) {
  return owner.type === 'org'
    ? eq(security_agent_repository_sync_state.owned_by_organization_id, owner.id)
    : eq(security_agent_repository_sync_state.owned_by_user_id, owner.id);
}

async function upsertSecurityAgentRepositorySyncState(
  db: SecurityAgentRepositorySyncStateDb,
  input: {
    owner: SecurityAgentCommandOwner;
    repoFullName: string;
    attemptedAt: Date;
    succeededAt?: Date | null;
    failureCode?: string | null;
  }
): Promise<void> {
  const values = {
    owned_by_organization_id: input.owner.type === 'org' ? input.owner.id : null,
    owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
    repo_full_name: input.repoFullName,
    last_attempted_at: input.attemptedAt.toISOString(),
    last_succeeded_at: input.succeededAt?.toISOString(),
    last_failure_code: input.failureCode,
    updated_at: input.attemptedAt.toISOString(),
  };
  const set = {
    last_attempted_at: values.last_attempted_at,
    last_succeeded_at: values.last_succeeded_at,
    last_failure_code: values.last_failure_code,
    updated_at: values.updated_at,
  };

  if (input.owner.type === 'org') {
    await db
      .insert(security_agent_repository_sync_state)
      .values(values)
      .onConflictDoUpdate({
        target: [
          security_agent_repository_sync_state.owned_by_organization_id,
          security_agent_repository_sync_state.repo_full_name,
        ],
        targetWhere: isNotNull(security_agent_repository_sync_state.owned_by_organization_id),
        set,
      });
    return;
  }

  await db
    .insert(security_agent_repository_sync_state)
    .values(values)
    .onConflictDoUpdate({
      target: [
        security_agent_repository_sync_state.owned_by_user_id,
        security_agent_repository_sync_state.repo_full_name,
      ],
      targetWhere: isNotNull(security_agent_repository_sync_state.owned_by_user_id),
      set,
    });
}

export async function recordSecurityAgentRepositorySyncAttempt(
  db: SecurityAgentRepositorySyncStateDb,
  input: { owner: SecurityAgentCommandOwner; repoFullName: string; attemptedAt?: Date }
): Promise<void> {
  await upsertSecurityAgentRepositorySyncState(db, {
    ...input,
    attemptedAt: input.attemptedAt ?? new Date(),
    failureCode: null,
  });
}

export async function recordSecurityAgentRepositorySyncSuccess(
  db: SecurityAgentRepositorySyncStateDb,
  input: { owner: SecurityAgentCommandOwner; repoFullName: string; succeededAt?: Date }
): Promise<void> {
  const succeededAt = input.succeededAt ?? new Date();
  await upsertSecurityAgentRepositorySyncState(db, {
    ...input,
    attemptedAt: succeededAt,
    succeededAt,
    failureCode: null,
  });
}

export async function recordSecurityAgentRepositorySyncFailure(
  db: SecurityAgentRepositorySyncStateDb,
  input: {
    owner: SecurityAgentCommandOwner;
    repoFullName: string;
    failureCode: string;
    attemptedAt?: Date;
  }
): Promise<void> {
  await upsertSecurityAgentRepositorySyncState(db, {
    ...input,
    attemptedAt: input.attemptedAt ?? new Date(),
  });
}

export async function getSecurityAgentRepositorySyncState(
  db: SecurityAgentRepositorySyncStateDb,
  owner: SecurityAgentCommandOwner,
  repoFullName: string
): Promise<SecurityAgentRepositorySyncState | null> {
  const [state] = await db
    .select()
    .from(security_agent_repository_sync_state)
    .where(
      and(ownerWhere(owner), eq(security_agent_repository_sync_state.repo_full_name, repoFullName))
    )
    .limit(1);

  return state ?? null;
}
