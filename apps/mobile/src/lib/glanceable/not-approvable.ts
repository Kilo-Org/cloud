import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';

import { trpcClient } from '@/lib/trpc';

/**
 * The session the ask names has no cloud-agent (control-plane) permission to
 * answer. Carries the tRPC-shaped `data.code` so the shared code reader
 * classifies it like any other terminal rejection.
 */
export class NotApprovableError extends Error {
  readonly data = { code: 'NOT_APPROVABLE' };

  constructor() {
    super('The session has no cloud-agent permission to answer');
    this.name = 'NotApprovableError';
  }
}

/**
 * Resolve the cloud-agent (control-plane) session id from the kilo session id.
 * The same `cliSessionsV2.get` read `resolveSession` uses; a row without a
 * cloud-agent id is not approvable.
 */
export async function resolveCloudAgentSessionId(kiloSessionId: string): Promise<string> {
  // The row id is a Kilo session id; the brand is only a compile-time marker.
  const session = await trpcClient.cliSessionsV2.get.query({
    session_id: kiloSessionId as KiloSessionId,
  });
  const cloudAgentSessionId = session.cloud_agent_session_id;
  if (!cloudAgentSessionId) {
    throw new NotApprovableError();
  }
  return cloudAgentSessionId;
}
