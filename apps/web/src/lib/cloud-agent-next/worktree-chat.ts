import 'server-only';
import type { User } from '@kilocode/db/schema';
import { cli_sessions_v2, organization_memberships } from '@kilocode/db/schema';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { createControlTokenForRequest } from '@/lib/auth/resource-delegation';
import { isMobileClient } from '@/lib/trpc/min-version';
import { createCloudAgentNextClient, type CreateWorktreeChatOutput } from './cloud-agent-client';

type CreateWorktreeChatOptions = {
  user: User;
  headersList?: Headers;
  sourceKiloSessionId: string;
  operationKey: string;
  organizationId?: string;
};

type WorktreeUpstreamErrorShape = {
  data?: { code?: unknown; httpStatus?: unknown };
  shape?: { data?: { code?: unknown; httpStatus?: unknown } } | null;
};

type WorktreeErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'PAYMENT_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'UNPROCESSABLE_CONTENT'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL_SERVER_ERROR'
  | 'BAD_GATEWAY'
  | 'SERVICE_UNAVAILABLE'
  | 'GATEWAY_TIMEOUT';

const worktreeErrorCodesByHttpStatus = new Map<number, WorktreeErrorCode>([
  [400, 'BAD_REQUEST'],
  [401, 'UNAUTHORIZED'],
  [402, 'PAYMENT_REQUIRED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [408, 'TIMEOUT'],
  [409, 'CONFLICT'],
  [412, 'PRECONDITION_FAILED'],
  [422, 'UNPROCESSABLE_CONTENT'],
  [429, 'TOO_MANY_REQUESTS'],
  [500, 'INTERNAL_SERVER_ERROR'],
  [502, 'BAD_GATEWAY'],
  [503, 'SERVICE_UNAVAILABLE'],
  [504, 'GATEWAY_TIMEOUT'],
]);

const safeWorktreeErrorMessages = new Set([
  'creation_in_progress',
  'operation_key_reuse_mismatch',
  'worktree_source_not_eligible',
  'worktree_chat_creation_failed',
  'worktree_chat_registration_failed',
]);

function getWorktreeErrorCode(error: WorktreeUpstreamErrorShape): WorktreeErrorCode | undefined {
  const code = error.data?.code ?? error.shape?.data?.code;
  if (
    code === 'BAD_REQUEST' ||
    code === 'UNAUTHORIZED' ||
    code === 'PAYMENT_REQUIRED' ||
    code === 'FORBIDDEN' ||
    code === 'NOT_FOUND' ||
    code === 'TIMEOUT' ||
    code === 'CONFLICT' ||
    code === 'PRECONDITION_FAILED' ||
    code === 'UNPROCESSABLE_CONTENT' ||
    code === 'TOO_MANY_REQUESTS' ||
    code === 'INTERNAL_SERVER_ERROR' ||
    code === 'BAD_GATEWAY' ||
    code === 'SERVICE_UNAVAILABLE' ||
    code === 'GATEWAY_TIMEOUT'
  ) {
    return code;
  }

  const status = error.data?.httpStatus ?? error.shape?.data?.httpStatus;
  return typeof status === 'number' ? worktreeErrorCodesByHttpStatus.get(status) : undefined;
}

export async function createWorktreeChat({
  user,
  headersList,
  sourceKiloSessionId,
  operationKey,
  organizationId,
}: CreateWorktreeChatOptions): Promise<CreateWorktreeChatOutput> {
  if (isMobileClient(headersList)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Worktree chats are only available in the browser',
    });
  }

  const organizationCondition = organizationId
    ? and(
        eq(cli_sessions_v2.organization_id, organizationId),
        isNotNull(organization_memberships.id)
      )
    : isNull(cli_sessions_v2.organization_id);

  const [source] = await db
    .select({
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
    })
    .from(cli_sessions_v2)
    .leftJoin(
      organization_memberships,
      and(
        eq(organization_memberships.organization_id, cli_sessions_v2.organization_id),
        eq(organization_memberships.kilo_user_id, user.id)
      )
    )
    .where(
      and(
        eq(cli_sessions_v2.session_id, sourceKiloSessionId),
        eq(cli_sessions_v2.kilo_user_id, user.id),
        organizationCondition
      )
    )
    .limit(1);

  if (!source) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Source session not found or access denied',
    });
  }

  if (
    !source.cloudAgentSessionId?.startsWith('workspace_') ||
    !z.uuid().safeParse(source.cloudAgentSessionId.slice('workspace_'.length)).success ||
    !cloudAgentWorktreeIdSchema.safeParse(source.worktreeId).success
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Source session is not part of a worktree',
    });
  }

  const { token } = await createControlTokenForRequest(user, 'cloud-agent-next', {
    headers: headersList ?? new Headers(),
    organizationId,
    tokenSource: 'cloud-agent',
  });
  try {
    return await createCloudAgentNextClient(token).createWorktreeChat({
      sourceKiloSessionId,
      sourceCloudAgentSessionId: source.cloudAgentSessionId,
      operationKey,
      ...(organizationId ? { kilocodeOrganizationId: organizationId } : {}),
      clientProvenance: 'browser',
    });
  } catch (error) {
    if (error instanceof TRPCClientError) {
      const code = getWorktreeErrorCode(error);
      if (code) {
        throw new TRPCError({
          code,
          message: safeWorktreeErrorMessages.has(error.message)
            ? error.message
            : 'Worktree chat request failed',
        });
      }
    }

    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Worktree chat service is unavailable',
    });
  }
}
