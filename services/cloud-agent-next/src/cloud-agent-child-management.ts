import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import {
  cloudAgentAuthorityProcedureKind,
  cloudAgentAuthorityProcedures,
  validateCloudAgentAuthorityRequest,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import { CLOUD_AGENT_PARENT_AUTHORITY_DENIED } from './cloud-agent-authority.js';
import type { SandboxSessionV2 } from './control-plane/session/session-do.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import { getSandboxSessionStub } from './sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from './session-access.js';
import type { Env } from './types.js';
import { withDORetry } from './utils/do-retry.js';

const MANAGEMENT_PROCEDURES = {
  listChildSessions: { base: 'listChildSessions', kind: 'query' },
  getSession: { base: 'getSession', kind: 'query' },
  getMessageResult: { base: 'getMessageResult', kind: 'query' },
  interruptSession: { base: 'interruptSession', kind: 'mutation' },
  sendMessageV2: { base: 'sendMessage', kind: 'mutation' },
} as const;

export type CloudAgentManagementPath = keyof typeof MANAGEMENT_PROCEDURES;

export function isCloudAgentManagementPath(path: string): path is CloudAgentManagementPath {
  return Object.hasOwn(MANAGEMENT_PROCEDURES, path);
}

function forbidden(message: string): TRPCError {
  return new TRPCError({ code: 'FORBIDDEN', message });
}

function targetFromRawInput(path: CloudAgentManagementPath, rawInput: unknown) {
  if (path === 'listChildSessions') return undefined;
  if (path === 'interruptSession') {
    const parsed = z
      .object({ sessionId: z.string().min(1) })
      .passthrough()
      .safeParse(rawInput);
    return parsed.success ? { childSessionId: parsed.data.sessionId } : undefined;
  }
  const parsed = z
    .object({
      cloudAgentSessionId: z.string().min(1),
      expectedWorktreeId: z.string().min(1).optional(),
    })
    .passthrough()
    .safeParse(rawInput);
  return parsed.success
    ? {
        childSessionId: parsed.data.cloudAgentSessionId,
        ...(parsed.data.expectedWorktreeId === undefined
          ? {}
          : { expectedWorktreeId: parsed.data.expectedWorktreeId }),
      }
    : undefined;
}

async function assertParentAuthority(env: Env, authority: CloudAgentAuthority): Promise<void> {
  try {
    await withDORetry(
      () => getSandboxSessionStub(env, authority.ownerId, authority.parentSessionId),
      stub => stub.assertCloudAgentManagementAuthority(authority),
      'assertCloudAgentManagementAuthority'
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes(CLOUD_AGENT_PARENT_AUTHORITY_DENIED)) {
      throw forbidden(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
    }
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Cloud Agent parent authority is temporarily unavailable',
      cause: { error: 'CLOUD_AGENT_PARENT_AUTHORITY_UNAVAILABLE', retryable: true },
    });
  }
}

async function readChildMetadata(
  env: Env,
  authority: CloudAgentAuthority,
  childSessionId: string
): Promise<SessionMetadata> {
  if (childSessionId === authority.parentSessionId) {
    throw forbidden('Cloud Agent target cannot be the parent session');
  }
  await requireCurrentSessionAccess({
    env,
    kiloUserId: authority.ownerId,
    cloudAgentSessionId: childSessionId,
    expectedOrganizationId: authority.organizationId,
  });
  const metadata = await withDORetry<DurableObjectStub<SandboxSessionV2>, SessionMetadata | null>(
    () => getSandboxSessionStub(env, authority.ownerId, childSessionId),
    stub => stub.getMetadata(),
    'getMetadata'
  );
  if (
    metadata === null ||
    metadata.identity.sessionId !== childSessionId ||
    metadata.identity.userId !== authority.ownerId ||
    (metadata.identity.orgId ?? null) !== authority.organizationId ||
    metadata.parentCloudAgentSessionId !== authority.parentSessionId
  ) {
    throw forbidden('Cloud Agent target is not a direct child of this parent');
  }
  return metadata;
}

export async function assertCloudAgentChildTarget(input: {
  env: Env;
  authority: CloudAgentAuthority;
  childSessionId: string;
  expectedWorktreeId?: string;
}): Promise<SessionMetadata> {
  const metadata = await readChildMetadata(input.env, input.authority, input.childSessionId);
  if (
    input.expectedWorktreeId !== undefined &&
    metadata.workspace?.worktreeId !== input.expectedWorktreeId
  ) {
    throw forbidden('Cloud Agent target worktree does not match');
  }
  return metadata;
}

export async function assertCloudAgentManagementRequest(input: {
  env: Env;
  authority: CloudAgentAuthority;
  userId?: string;
  authToken?: string;
  path: string;
  rawInput: unknown;
}): Promise<void> {
  if (
    input.authToken === undefined ||
    input.userId === undefined ||
    input.userId !== input.authority.ownerId
  ) {
    throw forbidden('Cloud Agent parent binding mismatch');
  }
  if (!isCloudAgentManagementPath(input.path)) {
    throw forbidden('Cloud Agent authority does not permit this procedure');
  }
  const spec = MANAGEMENT_PROCEDURES[input.path];
  const procedure =
    input.authority.organizationId === null
      ? `cloudAgentNext.${spec.base}`
      : `organizations.cloudAgentNext.${spec.base}`;
  if (
    !cloudAgentAuthorityProcedures(input.authority).includes(procedure) ||
    cloudAgentAuthorityProcedureKind(procedure) !== spec.kind
  ) {
    throw forbidden('Cloud Agent authority does not permit this procedure');
  }
  try {
    validateCloudAgentAuthorityRequest(input.authority, procedure, input.rawInput);
  } catch {
    throw forbidden('Cloud Agent management exceeds its authority');
  }
  await assertParentAuthority(input.env, input.authority);
  const target = targetFromRawInput(input.path, input.rawInput);
  if (target === undefined) {
    if (input.path === 'listChildSessions') return;
    throw forbidden('Cloud Agent management target is invalid');
  }
  await assertCloudAgentChildTarget({
    env: input.env,
    authority: input.authority,
    ...target,
  });
}

export async function listCloudAgentChildSessions(input: {
  env: Env;
  authority: CloudAgentAuthority;
  limit: number;
  cursor?: string;
}): Promise<{
  sessions: Array<{
    cloudAgentSessionId: string;
    initialMessageId?: string;
    worktreeId?: CloudAgentWorktreeId;
  }>;
  nextCursor?: string;
}> {
  const page = await withDORetry(
    () =>
      getSandboxSessionStub(input.env, input.authority.ownerId, input.authority.parentSessionId),
    stub =>
      stub.listCloudAgentChildSessions({
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
    'listCloudAgentChildSessions'
  );
  const sessions: Array<{
    cloudAgentSessionId: string;
    initialMessageId?: string;
    worktreeId?: CloudAgentWorktreeId;
  }> = [];
  for (const entry of page.sessions) {
    let metadata: SessionMetadata;
    try {
      metadata = await assertCloudAgentChildTarget({
        env: input.env,
        authority: input.authority,
        childSessionId: entry.cloudAgentSessionId,
      });
    } catch (error) {
      if (
        error instanceof TRPCError &&
        (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
      ) {
        continue;
      }
      throw error;
    }
    sessions.push({
      cloudAgentSessionId: entry.cloudAgentSessionId,
      ...(metadata.initialMessage?.id === undefined
        ? {}
        : { initialMessageId: metadata.initialMessage.id }),
      ...(metadata.workspace?.worktreeId === undefined
        ? {}
        : { worktreeId: metadata.workspace.worktreeId }),
    });
  }
  return {
    sessions,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}
