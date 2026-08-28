import 'server-only';
import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CommandSchema } from '@kilocode/agent-harness/commands';
import { ClientSchema } from '@kilocode/agent-harness/contracts';
import {
  agent_harness_clients,
  device_sessions,
  kilocode_users,
  type User,
} from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { getUserFromAuth } from '@/lib/user/server';

type Database = typeof db | DrizzleTransaction;

export function harnessAccessDenied(): never {
  throw new TRPCError({ code: 'FORBIDDEN', message: 'Harness access revoked or unavailable' });
}

function sessionBinding(user: User, deviceSessionId?: string) {
  const pepper = deviceSessionId ? user.api_token_pepper : user.web_session_pepper;
  const reference = createHash('sha256')
    .update(JSON.stringify([user.id, pepper ?? null]))
    .digest('hex');
  return deviceSessionId ? `device:${deviceSessionId}:${reference}` : `web:${reference}`;
}

/** Derive identity only from request authentication, never from a command or stored user object. */
export async function authenticateHarnessIdentity() {
  const auth = await getUserFromAuth({ adminOnly: false });
  if (!auth.user || auth.internalApiUse || auth.botId) harnessAccessDenied();
  if ((await headers()).has('authorization') && !auth.deviceSessionId) harnessAccessDenied();
  const deviceSessionId =
    auth.deviceSessionId && z.uuid().parse(auth.deviceSessionId).toLowerCase();
  return {
    userId: auth.user.id,
    sessionBinding: sessionBinding(auth.user, deviceSessionId),
    kind: deviceSessionId ? ('mobile' as const) : ('browser' as const),
    organizationId: auth.organizationId,
  };
}

async function currentSession(userId: string, binding: string, primary: Database) {
  // These locks serialize registration/grant acceptance with account and device revocation.
  const [user] = await primary
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .for('share');
  if (!user || user.blocked_reason !== null) harnessAccessDenied();
  const [kind, deviceSessionId] = binding.split(':');
  if (kind === 'device') {
    if (!z.uuid().safeParse(deviceSessionId).success) harnessAccessDenied();
    const [session] = await primary
      .select()
      .from(device_sessions)
      .where(
        and(
          eq(device_sessions.id, deviceSessionId),
          eq(device_sessions.kilo_user_id, userId),
          isNull(device_sessions.revoked_at)
        )
      )
      .for('share');
    if (!session || session.revoked_at !== null || session.kilo_user_id !== userId)
      harnessAccessDenied();
  } else if (kind !== 'web') harnessAccessDenied();
  if (binding !== sessionBinding(user, kind === 'device' ? deviceSessionId : undefined))
    harnessAccessDenied();
  return user;
}

function publicClient(row: typeof agent_harness_clients.$inferSelect) {
  return ClientSchema.parse({
    id: row.id,
    ownerUserId: row.user_id,
    kind: row.kind,
    supportedTools: row.supported_tools,
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  });
}

/** Internal callers supply the owner from authentication or a verified durable grant. */
export async function requireHarnessClient(
  userId: string,
  clientId: string,
  binding?: string,
  primary: Database = db
) {
  const [row] = await primary
    .select()
    .from(agent_harness_clients)
    .where(eq(agent_harness_clients.id, z.uuid().parse(clientId).toLowerCase()))
    .for('share');
  if (
    !row ||
    row.user_id !== userId ||
    row.revoked_at !== null ||
    (binding !== undefined && row.session_binding !== binding)
  )
    harnessAccessDenied();
  const user = await currentSession(userId, row.session_binding, primary);
  return { client: publicClient(row), user };
}

/** A replay can update availability, but cannot rebind or revive an installation/tab ID. */
export async function applyHarnessClientCommand(input: unknown) {
  const command = CommandSchema.parse(input);
  if (command.type !== 'registerClient' && command.type !== 'revokeClient') harnessAccessDenied();
  const identity = await authenticateHarnessIdentity();
  const revoking = command.type === 'revokeClient';
  if (!revoking && command.kind !== identity.kind) harnessAccessDenied();
  const supportedTools = command.type === 'registerClient' ? command.supportedTools : [];
  return db.transaction(async tx => {
    await currentSession(identity.userId, identity.sessionBinding, tx);
    const [row] = await tx
      .insert(agent_harness_clients)
      .values({
        id: command.clientId.toLowerCase(),
        user_id: identity.userId,
        kind: identity.kind,
        session_binding: identity.sessionBinding,
        supported_tools: supportedTools,
        revoked_at: revoking ? sql`clock_timestamp()` : null,
      })
      .onConflictDoUpdate({
        target: agent_harness_clients.id,
        set: revoking
          ? { revoked_at: sql`coalesce(${agent_harness_clients.revoked_at}, clock_timestamp())` }
          : { supported_tools: supportedTools },
        setWhere: and(
          eq(agent_harness_clients.user_id, identity.userId),
          eq(agent_harness_clients.kind, identity.kind),
          eq(agent_harness_clients.session_binding, identity.sessionBinding),
          revoking ? undefined : isNull(agent_harness_clients.revoked_at)
        ),
      })
      .returning();
    // Revocation inserts a tombstone even if an earlier registration has not committed yet.
    if (!row) harnessAccessDenied();
    return publicClient(row);
  });
}
