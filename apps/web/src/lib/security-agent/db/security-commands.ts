import { db } from '@/lib/drizzle';
import {
  getSecurityAgentCommandForOwner,
  listActiveSecurityAgentCommandsForOwner,
  type SecurityAgentCommandOwner,
} from '@kilocode/db';
import type { SecurityAgentCommand } from '@kilocode/db/schema';
import type { SecurityReviewOwner } from '../core/types';

function toCommandOwner(owner: SecurityReviewOwner): SecurityAgentCommandOwner {
  if ('organizationId' in owner && owner.organizationId) {
    return { type: 'org', id: owner.organizationId };
  }
  if ('userId' in owner && owner.userId) {
    return { type: 'user', id: owner.userId };
  }
  throw new Error('Invalid Security Agent owner');
}

function toIsoString(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export type SecurityAgentCommandStatusResponse = ReturnType<typeof serializeSecurityAgentCommand>;

function serializeSecurityAgentCommand(command: SecurityAgentCommand) {
  return {
    id: command.id,
    commandType: command.command_type,
    origin: command.origin,
    findingId: command.finding_id,
    repoFullName: command.repo_full_name,
    status: command.status,
    resultCode: command.result_code,
    lastErrorRedacted: command.last_error_redacted,
    acceptedAt: toIsoString(command.accepted_at),
    startedAt: toIsoString(command.started_at),
    completedAt: toIsoString(command.completed_at),
    updatedAt: toIsoString(command.updated_at),
  };
}

export async function getSecurityAgentCommandStatus(
  owner: SecurityReviewOwner,
  commandId: string
): Promise<SecurityAgentCommandStatusResponse | null> {
  const command = await getSecurityAgentCommandForOwner(db, toCommandOwner(owner), commandId);
  return command ? serializeSecurityAgentCommand(command) : null;
}

export async function listActiveSecurityAgentCommands(
  owner: SecurityReviewOwner
): Promise<SecurityAgentCommandStatusResponse[]> {
  const commands = await listActiveSecurityAgentCommandsForOwner(db, toCommandOwner(owner));
  return commands.map(serializeSecurityAgentCommand);
}
