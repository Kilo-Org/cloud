import { logger } from './logger.js';

/**
 * Best-effort `interruptSession` call for one Cloud Agent analysis session.
 *
 * Callers use it when a run is replaced, or when a prepared session will not be
 * started. It never throws, because the caller's own outcome is already
 * decided; a failed interrupt only leaves the session to end on its own
 * timeout.
 */
export async function interruptAnalysisCloudAgentSession(params: {
  env: CloudflareEnv;
  authToken: string;
  cloudAgentSessionId: string;
  findingId: string;
  commandId?: string;
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
