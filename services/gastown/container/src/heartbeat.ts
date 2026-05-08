import { listAgents } from './process-manager';
import { fetchFreshContainerToken } from './token-refresh';
import type { HeartbeatPayload } from './types';

const HEARTBEAT_INTERVAL_MS = 30_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let gastownApiUrl: string | null = null;
let sessionToken: string | null = null;
/** Set once we've successfully acknowledged container-ready. */
let containerReadyAcknowledged = false;

/**
 * Unique ID for this container instance. Generated once at import time.
 * Sent with every heartbeat so the TownDO can detect container restarts
 * (new instance ID ≠ old one → clear drain flag).
 */
const CONTAINER_INSTANCE_ID = crypto.randomUUID();

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
    if (response.ok) {
      containerReadyAcknowledged = true;
      console.log(`[heartbeat] container-ready acknowledged for town=${townId}`);
    } else {
      console.warn(
        `[heartbeat] container-ready failed for town=${townId}: ${response.status} ${response.statusText}`
      );
    }
  } catch (err) {
    console.warn(`[heartbeat] container-ready error for town=${townId}:`, err);
  }
}

async function sendHeartbeats(): Promise<void> {
  // Prefer the live container token (refreshed via POST /refresh-token)
  // over the token captured at startHeartbeat() time.
  const currentToken = process.env.GASTOWN_CONTAINER_TOKEN ?? sessionToken;
  if (!gastownApiUrl || !currentToken) return;

  const active = listAgents().filter(a => a.status === 'running' || a.status === 'starting');

  // When no agents are active, the per-agent heartbeat loop has
  // nothing to send. Idle container drain acknowledgment is handled
  // by the /health endpoint instead (the TownDO passes the nonce via
  // X-Drain-Nonce headers in ensureContainerReady).
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
      containerInstanceId: CONTAINER_INSTANCE_ID,
    };

    const url = `${gastownApiUrl}/api/towns/${agent.townId}/rigs/${agent.rigId}/agents/${agent.agentId}/heartbeat`;
    const doPost = (token: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

    try {
      let response = await doPost(currentToken);
      // On 401, mint a fresh token via the worker's refresh endpoint
      // (it tolerates expired tokens) and retry once.
      if (response.status === 401) {
        console.warn(
          `Heartbeat 401 for agent ${agent.agentId} — attempting one-shot token refresh`
        );
        const fresh = await fetchFreshContainerToken();
        if (fresh) {
          response = await doPost(fresh);
        }
      }

      if (!response.ok) {
        console.warn(
          `Heartbeat failed for agent ${agent.agentId}: ${response.status} ${response.statusText}`
        );
      } else if (!containerReadyAcknowledged) {
        // If the TownDO is draining, the heartbeat response includes a
        // drainNonce. Use it to call /container-ready and clear drain.
        try {
          const body = (await response.json()) as { data?: { drainNonce?: string } };
          const nonce = body?.data?.drainNonce;
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
