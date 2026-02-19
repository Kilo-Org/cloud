/**
 * Reports agent completion/failure back to the Rig DO via the Gastown
 * worker API. This closes the bead and unhooks the agent, preventing
 * the infinite retry loop where witnessPatrol resets the agent to idle
 * and schedulePendingWork re-dispatches it.
 */

import type { ManagedAgent } from './types';

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
  const token = agent.gastownSessionToken;
  if (!apiUrl || !token) {
    console.warn(
      `Cannot report agent ${agent.agentId} completion: no API credentials on agent record`
    );
    return;
  }

  const url = `${apiUrl}/api/rigs/${agent.rigId}/agents/${agent.agentId}/completed`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status, reason }),
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
