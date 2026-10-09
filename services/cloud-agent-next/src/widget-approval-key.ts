import * as z from 'zod';
import { sessionIdSchema as kiloSessionIdSchema } from '@kilocode/session-ingest-contracts';
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
 * permission. Raw permission ids, prompts and patterns never leave the Worker.
 * The key grants nothing: every approval re-reads the live request.
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

/** The first entry with a usable id: the DO keeps permissions in arrival order. */
function oldestPermissionId(permissions: readonly unknown[]): string | null {
  for (const permission of permissions) {
    if (typeof permission === 'object' && permission !== null && 'id' in permission) {
      const id = permission.id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return null;
}

/**
 * Resolve the approval key for one owned session. Ownership (user, exact
 * organization scope with live membership, and the Kilo/cloud session pairing)
 * is enforced by `requireCurrentSessionAccess`, which throws FORBIDDEN on any
 * mismatch. Only the control-plane Session DO is read: its pending set lives in
 * DO memory/storage, so no sandbox is woken. A legacy `agent_*` session keeps
 * its pending set only in its live wrapper, so it yields no key here.
 */
export async function readWidgetApprovalKey(
  env: Pick<Env, 'HYPERDRIVE' | 'SANDBOX_SESSION'>,
  request: WidgetApprovalKeyRequest
): Promise<string | null> {
  if (!isControlSession(request.cloudAgentSessionId)) return null;
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
  const permissionId = oldestPermissionId(pending.permissions);
  return permissionId === null ? null : widgetApprovalKey(request.kiloSessionId, permissionId);
}
