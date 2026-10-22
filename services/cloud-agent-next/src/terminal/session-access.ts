import { TRPCError } from '@trpc/server';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { requireCurrentSessionAccess } from '../session-access.js';
import type { Env } from '../types.js';

export async function checkTerminalSessionAccess(
  env: Pick<Env, 'HYPERDRIVE'>,
  metadata: SessionMetadata
): Promise<'allowed' | 'denied' | 'unavailable'> {
  try {
    await requireCurrentSessionAccess({
      env,
      kiloUserId: metadata.identity.userId,
      cloudAgentSessionId: metadata.identity.sessionId,
      expectedOrganizationId: metadata.identity.orgId ?? null,
      expectedKiloSessionId: metadata.auth.kiloSessionId,
    });
    return 'allowed';
  } catch (error) {
    return error instanceof TRPCError && error.code === 'FORBIDDEN' ? 'denied' : 'unavailable';
  }
}
