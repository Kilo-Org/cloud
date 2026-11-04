import { logger } from '../logger.js';
import { parseSessionMetadata } from '../persistence/session-metadata.js';
import type { CloudAgentSessionState } from '../persistence/types.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';

export class InvalidSessionMetadataError extends Error {
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
    public readonly details?: string
  ) {
    super(`Invalid session metadata for session ${sessionId}`);
    this.name = 'InvalidSessionMetadataError';
  }
}

export async function fetchSessionMetadata(
  env: Pick<Env, 'SANDBOX_SESSION'>,
  userId: string,
  sessionId: string
): Promise<CloudAgentSessionState | null> {
  const metadata = await withDORetry(
    () => getSandboxSessionStub(env, userId, sessionId),
    stub => stub.getMetadata(),
    'getMetadata'
  );
  if (!metadata) return null;
  try {
    return parseSessionMetadata(metadata);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.withFields({ userId, sessionId, reason }).error('Invalid session metadata shape');
    throw new InvalidSessionMetadataError(userId, sessionId, reason);
  }
}
