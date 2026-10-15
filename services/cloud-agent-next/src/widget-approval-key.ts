import * as z from 'zod';
import {
  sessionIdSchema as kiloSessionIdSchema,
  sessionLiveText,
  SESSION_LIVE_COMMAND_LIMIT,
} from '@kilocode/session-ingest-contracts';
import { sessionIdSchema } from './router/schemas.js';
import { requireCurrentSessionAccess } from './session-access.js';
import { isControlSession } from './session-plane.js';
import { getSandboxSessionStub } from './sandbox-session/session-stub.js';
import { withDORetry } from './utils/do-retry.js';
import type { Env } from './types.js';

/**
 * The Home widget's internal identity read: the trusted web backend names the
 * row it is about to show (user, organization scope, Kilo session, cloud
 * session) and receives only a SHA-256 binding of the oldest pending
 * permission, plus that request's command as one trimmed line (the session
 * card shows it, so the raw string leaves only cut to
 * `SESSION_LIVE_COMMAND_LIMIT`). Raw permission ids, prompts and patterns never
 * leave the Worker. The key grants nothing: every approval re-reads the live
 * request.
 */
export const widgetApprovalKeyRequestSchema = z
  .object({
    userId: z.string().min(1),
    organizationId: z.string().min(1).nullable(),
    kiloSessionId: kiloSessionIdSchema,
    cloudAgentSessionId: sessionIdSchema,
  })
  .strict();

export type WidgetApprovalKeyRequest = z.infer<typeof widgetApprovalKeyRequestSchema>;

/** The identity and command the read returns; both are null when nothing waits. */
export type WidgetApproval = { approvalKey: string | null; command: string | null };

const pendingPermissionsSchema = z.object({ permissions: z.array(z.unknown()) });

/** SHA-256 hex of `JSON.stringify([kiloSessionId, permissionId])`, the shared binding. */
export async function widgetApprovalKey(
  kiloSessionId: string,
  permissionId: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([kiloSessionId, permissionId]))
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The oldest pending permission: the DO keeps permissions in arrival order. */
function oldestPermission(permissions: readonly unknown[]): {
  id: string;
  command: string | null;
} | null {
  for (const permission of permissions) {
    if (typeof permission !== 'object' || permission === null || !('id' in permission)) continue;
    const id = permission.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const metadata = 'metadata' in permission ? permission.metadata : null;
    const rawCommand =
      typeof metadata === 'object' && metadata !== null && 'command' in metadata
        ? metadata.command
        : null;
    return { id, command: sessionLiveText(rawCommand, SESSION_LIVE_COMMAND_LIMIT) };
  }
  return null;
}

/**
 * Resolve the approval key and command for one owned session. Ownership (user,
 * exact organization scope with live membership, and the Kilo/cloud session
 * pairing) is enforced by `requireCurrentSessionAccess`, which throws FORBIDDEN
 * on any mismatch. Only the control-plane Session DO is read: its pending set
 * lives in DO memory/storage, so no sandbox is woken. A legacy `agent_*`
 * session keeps its pending set only in its live wrapper, so it yields no
 * identity here.
 */
export async function readWidgetApprovalKey(
  env: Pick<Env, 'HYPERDRIVE' | 'SANDBOX_SESSION'>,
  request: WidgetApprovalKeyRequest
): Promise<WidgetApproval> {
  if (!isControlSession(request.cloudAgentSessionId)) return { approvalKey: null, command: null };
  await requireCurrentSessionAccess({
    env,
    kiloUserId: request.userId,
    cloudAgentSessionId: request.cloudAgentSessionId,
    expectedOrganizationId: request.organizationId,
    expectedKiloSessionId: request.kiloSessionId,
  });
  const pending = pendingPermissionsSchema.parse(
    await withDORetry(
      () => getSandboxSessionStub(env, request.userId, request.cloudAgentSessionId),
      session => session.getPendingInteractions(),
      'getPendingInteractions'
    )
  );
  const permission = oldestPermission(pending.permissions);
  if (permission === null) return { approvalKey: null, command: null };
  return {
    approvalKey: await widgetApprovalKey(request.kiloSessionId, permission.id),
    command: permission.command,
  };
}
