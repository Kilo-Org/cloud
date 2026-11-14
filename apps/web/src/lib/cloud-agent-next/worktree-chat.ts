import 'server-only';
import type { User } from '@kilocode/db/schema';
import { cli_sessions_v2, organization_memberships, organizations } from '@kilocode/db/schema';
import {
  activeOrganizationJoinCondition,
  organizationMembershipJoinCondition,
} from '@kilocode/worker-utils/organization-membership';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createControlTokenForRequest } from '@/lib/auth/resource-delegation';
import { APP_CLIENT_HEADER, isMobileClient } from '@kilocode/web-shared/lib/app-headers';
import { createCloudAgentNextClient, type CreateWorktreeChatOutput } from './cloud-agent-client';
import { readCloudAgentErrorCode } from './cloud-agent-error';

type CreateWorktreeChatOptions = {
  user: User;
  headersList?: Headers;
  sourceKiloSessionId: string;
  operationKey: string;
  kiloSessionId?: string;
  organizationId?: string;
};

const WORKTREE_TRPC_CODES = new Set<TRPC_ERROR_CODE_KEY>([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'PAYMENT_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'TIMEOUT',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'UNPROCESSABLE_CONTENT',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
]);

const safeWorktreeErrorMessages = new Set([
  'creation_in_progress',
  'operation_key_reuse_mismatch',
  'worktree_source_not_eligible',
  'worktree_chat_creation_failed',
  'worktree_chat_registration_failed',
]);

function rejectsProposedSessionId(error: unknown): boolean {
  if (
    !(error instanceof TRPCClientError) ||
    readCloudAgentErrorCode(error, WORKTREE_TRPC_CODES) !== 'BAD_REQUEST'
  ) {
    return false;
  }
  try {
    return z
      .tuple([
        z.object({
          code: z.literal('unrecognized_keys'),
          keys: z.tuple([z.literal('kiloSessionId')]),
          path: z.tuple([]),
        }),
      ])
      .safeParse(JSON.parse(error.message)).success;
  } catch {
    return false;
  }
}

export async function createWorktreeChat({
  user,
  headersList,
  sourceKiloSessionId,
  operationKey,
  kiloSessionId,
  organizationId,
}: CreateWorktreeChatOptions): Promise<CreateWorktreeChatOutput> {
  if (isMobileClient(headersList?.get(APP_CLIENT_HEADER))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Worktree chats are only available in the browser',
    });
  }

  const organizationCondition = organizationId
    ? and(
        eq(cli_sessions_v2.organization_id, organizationId),
        isNotNull(organization_memberships.id),
        isNotNull(organizations.id)
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
      organizationMembershipJoinCondition(user.id, cli_sessions_v2.organization_id)
    )
    .leftJoin(organizations, activeOrganizationJoinCondition(cli_sessions_v2.organization_id))
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
    const client = createCloudAgentNextClient(token);
    const input = {
      sourceKiloSessionId,
      sourceCloudAgentSessionId: source.cloudAgentSessionId,
      operationKey,
      ...(organizationId ? { kilocodeOrganizationId: organizationId } : {}),
      clientProvenance: 'browser' as const,
    };
    return await client
      .createWorktreeChat({ ...input, ...(kiloSessionId ? { kiloSessionId } : {}) })
      .catch(error => {
        // Older Workers reject the field before admission, so this retry cannot duplicate a chat.
        if (kiloSessionId && rejectsProposedSessionId(error)) {
          return client.createWorktreeChat(input);
        }
        throw error;
      });
  } catch (error) {
    if (error instanceof TRPCClientError) {
      const code = readCloudAgentErrorCode(error, WORKTREE_TRPC_CODES);
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
