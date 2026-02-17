import { listProcesses } from './process-manager';
import type { HeartbeatPayload } from './types';

const HEARTBEAT_INTERVAL_MS = 30_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let gastownApiUrl: string | null = null;
let internalApiKey: string | null = null;

/**
 * Configure and start the heartbeat reporter.
 * Periodically sends agent status updates to the Gastown worker API,
 * which forwards them to the Rig DO to update `last_activity_at`.
 */
export function startHeartbeat(apiUrl: string, apiKey: string): void {
  gastownApiUrl = apiUrl;
  internalApiKey = apiKey;

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

async function sendHeartbeats(): Promise<void> {
  if (!gastownApiUrl || !internalApiKey) return;

  const active = listProcesses().filter(p => p.status === 'running' || p.status === 'starting');

  for (const agent of active) {
    const payload: HeartbeatPayload = {
      agentId: agent.agentId,
      rigId: agent.rigId,
      townId: agent.townId,
      status: agent.status,
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await fetch(
        `${gastownApiUrl}/api/rigs/${agent.rigId}/agents/${agent.agentId}/heartbeat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-API-Key': internalApiKey,
          },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        console.warn(
          `Heartbeat failed for agent ${agent.agentId}: ${response.status} ${response.statusText}`
        );
      }
    } catch (err) {
      console.warn(`Heartbeat error for agent ${agent.agentId}:`, err);
    }
  }
}
