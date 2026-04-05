/**
 * Reports agent completion/failure back to the Rig DO via the Gastown
 * worker API. This closes the bead and unhooks the agent, preventing
 * the infinite retry loop where witnessPatrol resets the agent to idle
 * and schedulePendingWork re-dispatches it.
 */

import type { ManagedAgent } from './types';

/**
 * Notify the TownDO that the mayor has finished processing a prompt and
 * is now waiting for user input. This lets the TownDO transition the
 * mayor from "working" to "waiting", which drops the alarm to the idle
 * cadence and stops health-check pings that reset the container's
 * sleepAfter timer.
 *
 * Best-effort: errors are logged but do not propagate.
 */
export async function reportMayorWaiting(agent: ManagedAgent): Promise<void> {
  const apiUrl = agent.gastownApiUrl;
  const authToken =
    process.env.GASTOWN_CONTAINER_TOKEN ?? agent.gastownContainerToken ?? agent.gastownSessionToken;
  if (!apiUrl || !authToken) {
    console.warn(
      `Cannot report mayor ${agent.agentId} waiting: no API credentials on agent record`
    );
    return;
  }

  const url = `${apiUrl}/api/towns/${agent.townId}/rigs/${agent.rigId}/agents/${agent.agentId}/waiting`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ agentId: agent.agentId, firedAt: Date.now() }),
    });

    if (!response.ok) {
      console.warn(
        `Failed to report mayor ${agent.agentId} waiting: ${response.status} ${response.statusText}`
      );
    }
  } catch (err) {
    console.warn(`Error reporting mayor ${agent.agentId} waiting:`, err);
  }
}

/**
 * Notify the Rig DO that an agent session has completed or failed.
 * Best-effort: errors are logged but do not propagate.
 */
export async function reportAgentCompleted(
  agent: ManagedAgent,
  status: 'completed' | 'failed',
  reason?: string
): Promise<void> {
  const apiUrl = agent.gastownApiUrl;
  // Prefer live container token (refreshed via POST /refresh-token)
  const authToken =
    process.env.GASTOWN_CONTAINER_TOKEN ?? agent.gastownContainerToken ?? agent.gastownSessionToken;
  if (!apiUrl || !authToken) {
    console.warn(
      `Cannot report agent ${agent.agentId} completion: no API credentials on agent record`
    );
    return;
  }

  const url =
    agent.completionCallbackUrl ??
    `${apiUrl}/api/towns/${agent.townId}/rigs/${agent.rigId}/agents/${agent.agentId}/completed`;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status, reason, agentId: agent.agentId }),
    });

    if (!response.ok) {
      console.warn(
        `Failed to report agent ${agent.agentId} completion: ${response.status} ${response.statusText}`
      );
    } else {
      console.log(`Reported agent ${agent.agentId} ${status} to Rig DO`);
    }
  } catch (err) {
    console.warn(`Error reporting agent ${agent.agentId} completion:`, err);
  }
}
