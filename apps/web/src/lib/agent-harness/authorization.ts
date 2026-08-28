import 'server-only';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { canonicalizeValidatedInput } from '@kilocode/agent-harness/commands';
import { ExecutionTargetSchema } from '@kilocode/agent-harness/contracts';
import { toolDefinitions } from '@kilocode/agent-harness/tools';
import { createQuickChatRuntime, QuickChatAuthoritySchema } from '@kilocode/db/quick-chat-runtime';
import {
  agent_harness_conversation_grants,
  agent_harness_conversation_registry,
  kilocode_users,
} from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import type { TRPCContext } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { authenticateHarnessIdentity, harnessAccessDenied, requireHarnessClient } from './clients';

const Id = z.uuid().transform(value => value.toLowerCase());
export const HarnessCapabilityScopeSchema = z.strictObject({
  audience: z.string().min(1),
  conversationId: Id,
  operation: z.string().min(1),
  definitionVersion: z.string().min(1),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  dispatchId: Id,
  target: ExecutionTargetSchema,
});
export type HarnessCapabilityScope = z.infer<typeof HarnessCapabilityScopeSchema>;
const ClaimsSchema = z.strictObject({
  scope: HarnessCapabilityScopeSchema,
  grantId: Id,
  authority: QuickChatAuthoritySchema.strict(),
  iss: z.literal('agent-harness'),
  aud: z.string().min(1),
  iat: z.int().nonnegative(),
  exp: z.int().positive(),
});
const RequestScopeSchema = z.strictObject({ conversationId: Id, clientId: Id });
type Database = typeof db | DrizzleTransaction;

export function harnessInputDigest(input: unknown) {
  return createHash('sha256')
    .update(canonicalizeValidatedInput(z.json().parse(input)))
    .digest('hex');
}

async function currentAuthority(
  conversationId: string,
  ownerUserId: string,
  primary: Database = db
) {
  const registry = await primary.query.agent_harness_conversation_registry.findFirst({
    where: eq(agent_harness_conversation_registry.thread_id, conversationId),
  });
  if (!registry || registry.user_id !== ownerUserId) harnessAccessDenied();
  const authority = QuickChatAuthoritySchema.parse({
    threadId: conversationId,
    userId: ownerUserId,
    organizationId: registry.organization_id,
    generation: registry.generation,
  });
  if (!(await createQuickChatRuntime(primary).lookupThread(authority))) harnessAccessDenied();
  const user = await primary.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, ownerUserId),
  });
  if (!user || user.blocked_reason !== null) harnessAccessDenied();
  // No stored user, caller-supplied actor, IP, headers, or admin flags enter a reconstructed context.
  const ctx: TRPCContext = { user, authViaToken: true, tokenSource: 'agent-harness', ip: null };
  const role =
    authority.organizationId === null
      ? null
      : await ensureOrganizationAccess(ctx, authority.organizationId);
  return { authority, ctx, role };
}

/** Gate every new read, command, claim, and completion with the current request and client. */
export async function authorizeHarnessRequest(input: unknown) {
  const scope = RequestScopeSchema.parse(input);
  const identity = await authenticateHarnessIdentity();
  return db.transaction(async tx => {
    const { client } = await requireHarnessClient(
      identity.userId,
      scope.clientId,
      identity.sessionBinding,
      tx
    );
    const current = await currentAuthority(scope.conversationId, identity.userId, tx);
    if (identity.organizationId && identity.organizationId !== current.authority.organizationId)
      harnessAccessDenied();
    return { ...current, client };
  });
}

/** Explicit acceptance creates a new reference. Capability renewal never creates or revives a grant. */
export async function createHarnessGrant(input: unknown) {
  const scope = RequestScopeSchema.extend({ expiresAt: z.iso.datetime() }).parse(input);
  if (!(Date.parse(scope.expiresAt) > Date.now())) harnessAccessDenied();
  const identity = await authenticateHarnessIdentity();
  return db.transaction(async tx => {
    await requireHarnessClient(identity.userId, scope.clientId, identity.sessionBinding, tx);
    const { authority } = await currentAuthority(scope.conversationId, identity.userId, tx);
    if (identity.organizationId && identity.organizationId !== authority.organizationId)
      harnessAccessDenied();
    const [grant] = await tx
      .insert(agent_harness_conversation_grants)
      .values({
        thread_id: authority.threadId,
        user_id: authority.userId,
        client_id: scope.clientId,
        generation: authority.generation,
        expires_at: scope.expiresAt,
      })
      .returning();
    if (!grant) harnessAccessDenied();
    return grant.id;
  });
}

async function currentGrant(grantId: string) {
  const grant = await db.query.agent_harness_conversation_grants.findFirst({
    where: eq(agent_harness_conversation_grants.id, Id.parse(grantId)),
  });
  if (!grant || grant.revoked_at !== null || !(Date.parse(grant.expires_at) > Date.now()))
    harnessAccessDenied();
  try {
    const current = await currentAuthority(grant.thread_id, grant.user_id);
    if (current.authority.generation !== grant.generation) harnessAccessDenied();
    return { ...current, grant };
  } catch (error) {
    // An observed authority loss is permanent for this grant, even if membership returns later.
    // Storage failures remain retryable and must not turn into permanent revocation.
    if (
      error instanceof TRPCError &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
    ) {
      await db
        .update(agent_harness_conversation_grants)
        .set({ revoked_at: sql`clock_timestamp()` })
        .where(
          and(
            eq(agent_harness_conversation_grants.id, grant.id),
            isNull(agent_harness_conversation_grants.revoked_at)
          )
        );
    }
    throw error;
  }
}

async function currentDispatch(grantId: string, scope: HarnessCapabilityScope) {
  const definition = toolDefinitions.find(tool => tool.name === scope.operation);
  if (
    definition &&
    (definition.executorKind !== scope.target.kind ||
      definition.version !== scope.definitionVersion)
  )
    harnessAccessDenied();
  const current = await currentGrant(grantId);
  if (current.authority.threadId !== scope.conversationId) harnessAccessDenied();
  if (scope.target.kind === 'client') {
    if (scope.target.clientId !== current.grant.client_id) harnessAccessDenied();
    const { client } = await requireHarnessClient(current.authority.userId, scope.target.clientId);
    if (
      !client.supportedTools.some(
        tool => tool.name === scope.operation && tool.version === scope.definitionVersion
      )
    )
      harnessAccessDenied();
  }
  // Backend work deliberately ignores origin-client connectivity, logout, and session revocation.
  return current;
}

export async function mintHarnessCapability(grantId: string, input: HarnessCapabilityScope) {
  const scope = HarnessCapabilityScopeSchema.parse(input);
  const { grant, authority } = await currentDispatch(grantId, scope);
  const iat = Math.floor(Date.now() / 1000);
  const exp = Math.min(iat + 60, Math.floor(Date.parse(grant.expires_at) / 1000));
  if (exp <= iat) harnessAccessDenied();
  return jwt.sign({ scope, grantId: grant.id, authority, iat, exp }, NEXTAUTH_SECRET, {
    algorithm: 'HS256',
    issuer: 'agent-harness',
    audience: scope.audience,
  });
}

/** Each internal entry supplies its own expected scope, including the actual validated input digest. */
export async function authorizeHarnessCapability(token: string, expected: HarnessCapabilityScope) {
  const scope = HarnessCapabilityScopeSchema.parse(expected);
  let claims: z.infer<typeof ClaimsSchema>;
  try {
    claims = ClaimsSchema.parse(
      jwt.verify(token, NEXTAUTH_SECRET, {
        algorithms: ['HS256'],
        issuer: 'agent-harness',
        audience: scope.audience,
        maxAge: 60,
      })
    );
  } catch {
    harnessAccessDenied();
  }
  if (
    claims.iat > Math.floor(Date.now() / 1000) ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 60 ||
    canonicalizeValidatedInput(claims.scope) !== canonicalizeValidatedInput(scope)
  )
    harnessAccessDenied();
  const current = await currentDispatch(claims.grantId, scope);
  if (
    canonicalizeValidatedInput(claims.authority) !== canonicalizeValidatedInput(current.authority)
  )
    harnessAccessDenied();
  return current;
}
