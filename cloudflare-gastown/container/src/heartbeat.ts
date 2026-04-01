import { z } from 'zod';
import { listAgents } from './process-manager';
import type { HeartbeatPayload } from './types';

const ContainerReadyResponse = z.object({
  data: z.object({ cleared: z.boolean() }),
});

const DrainStatusResponse = z.object({
  data: z.object({ draining: z.boolean(), drainNonce: z.string().nullable() }),
});

/** Heartbeat response may optionally include a drain nonce. */
const HeartbeatResponse = z.object({
  data: z.object({ drainNonce: z.string().optional() }).passthrough(),
});

const HEARTBEAT_INTERVAL_MS = 30_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let gastownApiUrl: string | null = null;
let sessionToken: string | null = null;
/** Set once we've successfully acknowledged container-ready. */
let containerReadyAcknowledged = false;

/**
 * Configure and start the heartbeat reporter.
 * Periodically sends agent status updates to the Gastown worker API,
 * which forwards them to the Rig DO to update `last_activity_at`.
 */
export function startHeartbeat(apiUrl: string, token: string): void {
  gastownApiUrl = apiUrl;
  sessionToken = token;

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  heartbeatTimer = setInterval(() => {
    void sendHeartbeats();
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`Heartbeat reporter started (interval=${HEARTBEAT_INTERVAL_MS}ms)`);
}

/**
 * Stop the heartbeat reporter.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  console.log('Heartbeat reporter stopped');
}

/**
 * Notify the TownDO that the replacement container is ready.
 * Exported so the health endpoint can trigger it when the TownDO
 * passes the drain nonce via headers (handles idle containers that
 * have no running agents and thus no per-agent heartbeats).
 */
export async function notifyContainerReady(townId: string, drainNonce: string): Promise<void> {
  if (containerReadyAcknowledged) return;
  await acknowledgeContainerReady(townId, drainNonce);
}

/**
 * Call POST /container-ready to acknowledge that this is a fresh
 * container replacing an evicted one. Clears the TownDO drain flag
 * so the reconciler can resume dispatching.
 */
async function acknowledgeContainerReady(townId: string, drainNonce: string): Promise<void> {
  const apiUrl = gastownApiUrl ?? process.env.GASTOWN_API_URL;
  const currentToken = process.env.GASTOWN_CONTAINER_TOKEN ?? sessionToken;
  if (!apiUrl || !currentToken) return;

  try {
    const response = await fetch(`${apiUrl}/api/towns/${townId}/container-ready`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentToken}`,
      },
      body: JSON.stringify({ nonce: drainNonce }),
    });
    if (!response.ok) {
      console.warn(
        `[heartbeat] container-ready failed for town=${townId}: ${response.status} ${response.statusText}`
      );
      return;
    }

    const parsed = ContainerReadyResponse.safeParse(await response.json());
    if (!parsed.success) {
      console.warn(`[heartbeat] container-ready unexpected response for town=${townId}`);
      return;
    }

    if (parsed.data.data.cleared) {
      containerReadyAcknowledged = true;
      console.log(`[heartbeat] container-ready acknowledged for town=${townId}`);
    } else {
      console.warn(`[heartbeat] container-ready nonce rejected for town=${townId}, will retry`);
    }
  } catch (err) {
    console.warn(`[heartbeat] container-ready error for town=${townId}:`, err);
  }
}

/**
 * Poll GET /drain-status to discover whether the TownDO is draining.
 * If a drain nonce is present, immediately call /container-ready to
 * clear the drain. Runs on every heartbeat tick regardless of active
 * agent count so idle replacement containers can unblock dispatch.
 */
async function pollDrainStatus(apiUrl: string, token: string): Promise<void> {
  const townId = process.env.GASTOWN_TOWN_ID;
  if (!townId) return;

  try {
    const response = await fetch(`${apiUrl}/api/towns/${townId}/drain-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;

    const parsed = DrainStatusResponse.safeParse(await response.json());
    if (!parsed.success) return;

    if (parsed.data.data.drainNonce) {
      await acknowledgeContainerReady(townId, parsed.data.data.drainNonce);
    }
  } catch {
    // Network error — will retry on next heartbeat tick
  }
}

async function sendHeartbeats(): Promise<void> {
  // Prefer the live container token (refreshed via POST /refresh-token)
  // over the token captured at startHeartbeat() time.
  const currentToken = process.env.GASTOWN_CONTAINER_TOKEN ?? sessionToken;
  if (!gastownApiUrl || !currentToken) return;

  // Poll drain status on every tick so idle containers (zero agents)
  // can discover the nonce and clear the drain flag promptly.
  if (!containerReadyAcknowledged) {
    await pollDrainStatus(gastownApiUrl, currentToken);
  }

  const active = listAgents().filter(a => a.status === 'running' || a.status === 'starting');
  if (active.length === 0) return;

  for (const agent of active) {
    const payload: HeartbeatPayload = {
      agentId: agent.agentId,
      rigId: agent.rigId,
      townId: agent.townId,
      status: agent.status,
      timestamp: new Date().toISOString(),
      lastEventType: agent.lastEventType ?? null,
      lastEventAt: agent.lastEventAt ?? null,
      activeTools: agent.activeTools ?? [],
      messageCount: agent.messageCount ?? 0,
    };

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentToken}`,
      };
      const response = await fetch(
        `${gastownApiUrl}/api/towns/${agent.townId}/rigs/${agent.rigId}/agents/${agent.agentId}/heartbeat`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        console.warn(
          `Heartbeat failed for agent ${agent.agentId}: ${response.status} ${response.statusText}`
        );
      } else if (!containerReadyAcknowledged) {
        // If the TownDO is draining, the heartbeat response includes a
        // drainNonce. Use it to call /container-ready and clear drain.
        try {
          const parsed = HeartbeatResponse.safeParse(await response.json());
          const nonce = parsed.success ? parsed.data.data.drainNonce : null;
          if (nonce) {
            void acknowledgeContainerReady(agent.townId, nonce);
          }
        } catch {
          // Non-JSON or unexpected shape — ignore
        }
      }
    } catch (err) {
      console.warn(`Heartbeat error for agent ${agent.agentId}:`, err);
    }
  }
}
