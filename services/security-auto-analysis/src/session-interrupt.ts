import { logger } from './logger.js';

/**
 * Bound on the best-effort interrupt call. Callers run it on a path whose
 * outcome is already decided, so a peer that accepts the request and never
 * answers must not hold that outcome back: the request carries its own
 * deadline, and a timeout ends the call the same way a failed interrupt does.
 */
export const SESSION_INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * Best-effort `interruptSession` call for one Cloud Agent analysis session.
 *
 * Callers use it when a run is replaced, or when a prepared session will not be
 * started. It never throws, because the caller's own outcome is already
 * decided; a failed or timed-out interrupt only leaves the session to end on
 * its own timeout.
 *
 * `timeoutMs` exists for tests, which need a short bound to observe the
 * deadline; callers use the default.
 */
export async function interruptAnalysisCloudAgentSession(params: {
  env: CloudflareEnv;
  authToken: string;
  cloudAgentSessionId: string;
  findingId: string;
  commandId?: string;
  timeoutMs?: number;
}): Promise<void> {
  try {
    const response = await params.env.CLOUD_AGENT_NEXT.fetch(
      new Request('https://cloud-agent-next/trpc/interruptSession', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.authToken}`,
        },
        body: JSON.stringify({ sessionId: params.cloudAgentSessionId }),
        signal: AbortSignal.timeout(params.timeoutMs ?? SESSION_INTERRUPT_TIMEOUT_MS),
      })
    );
    if (!response.ok) {
      logger.warn('Cloud Agent analysis session interrupt returned non-OK status', {
        cloud_agent_session_id: params.cloudAgentSessionId,
        finding_id: params.findingId,
        command_id: params.commandId,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn('Cloud Agent analysis session interrupt failed', {
      cloud_agent_session_id: params.cloudAgentSessionId,
      finding_id: params.findingId,
      command_id: params.commandId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
