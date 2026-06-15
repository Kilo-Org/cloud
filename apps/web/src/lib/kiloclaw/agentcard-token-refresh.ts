import 'server-only';

import { and, eq, lte } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { kiloclaw_agentcard_oauth_connections } from '@kilocode/db/schema';
import { getInstanceById, workerInstanceId } from '@/lib/kiloclaw/instance-registry';
import { refreshAgentCardToken } from '@/lib/integrations/agentcard/agentcard-service';
import {
  decryptRefreshToken,
  setKiloClawAgentCardOAuthConnectionError,
  upsertKiloClawAgentCardOAuthConnection,
} from '@/lib/kiloclaw/agentcard-oauth-connections';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';

// The OpenClaw worker reads this env secret to configure the `agentcard` MCP
// server's Bearer header (see services/kiloclaw/controller/src/config-writer.ts).
const AGENTCARD_SECRET_KEY = 'AGENTCARD_API_KEY';

export type AgentCardRefreshSweepResult = {
  scanned: number;
  refreshed: number;
  failed: number;
  skipped: number;
};

/**
 * Refresh Agentcard OAuth access tokens that are close to expiry and re-push
 * the new token to each connection's worker so the agent's `agentcard` MCP
 * server keeps a valid Bearer.
 *
 * Agentcard access tokens live ~1h; this is meant to run on a cron a few times
 * an hour with a window comfortably larger than the cron interval so a token
 * is always refreshed before it expires. Per-connection failures are isolated
 * (the connection is marked `action_required`) so one bad refresh can't abort
 * the sweep.
 */
export async function refreshExpiringAgentCardConnections(opts: {
  withinMs: number;
}): Promise<AgentCardRefreshSweepResult> {
  const cutoffIso = new Date(Date.now() + opts.withinMs).toISOString();

  // Only active connections with a known expiry inside the window. Rows with a
  // null token_expires_at are excluded by the SQL comparison (expected: every
  // token Agentcard issues carries expires_in).
  const rows = await db
    .select()
    .from(kiloclaw_agentcard_oauth_connections)
    .where(
      and(
        eq(kiloclaw_agentcard_oauth_connections.status, 'active'),
        lte(kiloclaw_agentcard_oauth_connections.token_expires_at, cutoffIso)
      )
    );

  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  const client = new KiloClawInternalClient();

  for (const conn of rows) {
    const refreshToken = decryptRefreshToken(conn);
    if (!refreshToken) {
      // No refresh token — can't renew unattended; leave for the user to reconnect.
      skipped++;
      continue;
    }

    const instance = await getInstanceById(conn.instance_id);
    if (!instance) {
      skipped++;
      continue;
    }

    try {
      const tokens = await refreshAgentCardToken({
        refreshToken,
        clientId: conn.oauth_client_id,
      });
      await upsertKiloClawAgentCardOAuthConnection({
        instanceId: conn.instance_id,
        oauthClientId: conn.oauth_client_id,
        tokens,
        accountEmail: conn.account_email,
      });
      await client.patchSecrets(
        instance.userId,
        { secrets: { [AGENTCARD_SECRET_KEY]: encryptKiloClawSecret(tokens.accessToken) } },
        workerInstanceId(instance)
      );
      refreshed++;
    } catch (error) {
      await setKiloClawAgentCardOAuthConnectionError(
        conn.instance_id,
        error instanceof Error ? error.message : 'Agentcard token refresh failed'
      );
      failed++;
    }
  }

  return { scanned: rows.length, refreshed, failed, skipped };
}
