import 'server-only';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { toolDefinitions } from '@kilocode/agent-harness/tools';
import { createQuickChatRuntime } from '@kilocode/db/quick-chat-runtime';
import {
  agent_harness_conversation_grants,
  agent_harness_conversation_registry,
  agent_harness_invitation_results,
  kilocode_users,
  organization_memberships,
  organizations,
  quick_chat_threads,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import type { TRPCContext } from '@/lib/trpc/init';
import { inviteOrganizationMember } from '@/lib/organizations/member-invitation';
import { OrganizationRoleSchema } from '@/lib/organizations/organization-types';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { authorizeHarnessCapability, harnessInputDigest } from './authorization';
import { harnessAccessDenied } from './clients';

const definition = toolDefinitions.find(tool => tool.name === 'kilo.invite');
if (!definition) throw new Error('Missing invitation tool definition');
const OutputSchema = definition.outputSchema;
const Id = z.uuid().transform(value => value.toLowerCase());
const InvocationSchema = z.strictObject({
  conversationId: Id,
  operationId: Id,
  arguments: definition.inputSchema.extend({ role: OrganizationRoleSchema }).readonly(),
});
const CanonicalResultSchema = z.strictObject({
  invitationId: z.uuid(),
  acceptInviteUrl: z.url({ protocol: /^https?$/ }),
  emailStatus: z.literal('pending'),
});

async function invitationOperation(token: string, input: unknown, reconcileOnly: boolean) {
  const invocation = InvocationSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(invocation), 'utf8') > 64 * 1024) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Invitation input exceeds 64 KiB' });
  }
  const inputDigest = harnessInputDigest(invocation.arguments);
  const { authority, grant } = await authorizeHarnessCapability(token, {
    audience: 'agent-harness:operations',
    conversationId: invocation.conversationId,
    operation: 'kilo.invite',
    definitionVersion: '1',
    inputDigest,
    dispatchId: invocation.operationId,
    target: { kind: 'backend' },
  });
  const organizationId = authority.organizationId;
  if (organizationId === null) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Invitations require an organization conversation',
    });
  }

  return db.transaction(async tx => {
    // Account deletion locks the user before retiring its threads. Use the same order.
    const [user] = await tx
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, authority.userId))
      .for('share');
    // The existing thread serializes admission even when no operation row exists.
    // Lock it before registry/context rows, matching retirement and history transactions.
    const [thread] = await tx
      .select({ id: quick_chat_threads.id })
      .from(quick_chat_threads)
      .where(eq(quick_chat_threads.id, authority.threadId))
      .for('update');
    if (!thread) harnessAccessDenied();
    await tx
      .select({ id: agent_harness_conversation_registry.thread_id })
      .from(agent_harness_conversation_registry)
      .where(eq(agent_harness_conversation_registry.thread_id, authority.threadId))
      .for('share');
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('update');
    if (!user || user.blocked_reason !== null || !organization || organization.deleted_at !== null)
      harnessAccessDenied();
    await tx
      .select({ id: organization_memberships.id })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.kilo_user_id, user.id),
          inArray(
            organization_memberships.organization_id,
            organization.parent_organization_id
              ? [organizationId, organization.parent_organization_id]
              : [organizationId]
          )
        )
      )
      .orderBy(organization_memberships.organization_id)
      .for('share');
    const [currentGrant] = await tx
      .select()
      .from(agent_harness_conversation_grants)
      .where(eq(agent_harness_conversation_grants.id, grant.id))
      .for('share');
    // Check expiry after waiting for the row lock, not in a pre-lock WHERE snapshot.
    if (
      !currentGrant ||
      currentGrant.thread_id !== authority.threadId ||
      currentGrant.user_id !== user.id ||
      currentGrant.generation !== authority.generation ||
      currentGrant.revoked_at !== null ||
      !(Date.parse(currentGrant.expires_at) > Date.now()) ||
      !(await createQuickChatRuntime(tx).lookupThread(authority))
    )
      harnessAccessDenied();
    const ctx: TRPCContext = { user, authViaToken: true, tokenSource: 'agent-harness', ip: null };
    // The membership locks keep the existing primary authorization helper current through commit.
    // Accepted backend work does not depend on the origin client's session or connection.
    await ensureOrganizationAccess(ctx, organizationId, undefined, tx);

    const [recorded] = await tx
      .select()
      .from(agent_harness_invitation_results)
      .where(
        and(
          eq(agent_harness_invitation_results.thread_id, authority.threadId),
          eq(agent_harness_invitation_results.operation_id, invocation.operationId)
        )
      )
      .for('update');
    if (recorded) {
      if (recorded.input_digest !== inputDigest) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This invitation operation has different input',
        });
      }
      const result = CanonicalResultSchema.safeParse(recorded.canonical_result);
      if (!result.success || result.data.invitationId !== recorded.invitation_id) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid recorded invitation result',
        });
      }
      // No expiry or invitation lookup: acceptance, revocation, and delivery cannot readmit this ID.
      return result.data;
    }
    // Reconciliation never creates an invitation, including when an earlier transaction rolled back.
    if (reconcileOnly) return null;
    const result = await inviteOrganizationMember(
      ctx,
      { organizationId, email: invocation.arguments.recipient, role: invocation.arguments.role },
      tx
    );
    await tx.insert(agent_harness_invitation_results).values({
      thread_id: authority.threadId,
      operation_id: invocation.operationId,
      input_digest: inputDigest,
      invitation_id: result.invitationId,
      canonical_result: result,
    });
    return result;
  });
}

export async function executeHarnessInvitation(token: string, input: unknown) {
  const result = await invitationOperation(token, input, false);
  if (!result) throw new Error('Invitation execution returned no result');
  // The fixed UUID/boolean schema bounds output and exposes no invitation secret or delivery claim.
  return OutputSchema.parse({ invitationId: result.invitationId, emailQueued: true });
}

export async function reconcileHarnessInvitation(token: string, input: unknown) {
  const result = await invitationOperation(token, input, true);
  return result
    ? OutputSchema.parse({ invitationId: result.invitationId, emailQueued: true })
    : null;
}
