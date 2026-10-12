import type { Env } from '../env';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { resolveAccessibleKiloSession } from './session-access';
import { withDORetry } from '@kilocode/worker-utils';

export type SessionExportResult =
  | { status: 'ok'; stream: ReadableStream<Uint8Array> }
  | { status: 'session_not_found' }
  | { status: 'clone_cut_not_found' };

/**
 * Fetch the session export as a streaming ReadableStream.
 *
 * Verifies that the session belongs to the user and that organization access
 * is current before reading the DO. With `upToMessageId`, the export holds only
 * the transcript up to and including that message and an empty `sessionDiff`;
 * a cut message that is not in the session yields `clone_cut_not_found`.
 */
export async function getSessionExport(
  env: Env,
  sessionId: string,
  kiloUserId: string,
  upToMessageId?: string
): Promise<SessionExportResult> {
  const accessibleSession = await resolveAccessibleKiloSession(env, {
    kiloUserId,
    kiloSessionId: sessionId,
  });
  if (!accessibleSession) {
    return { status: 'session_not_found' };
  }

  const stub = () => getSessionIngestDO(env, { kiloUserId, sessionId });
  if (upToMessageId !== undefined) {
    const hasCut = await withDORetry(
      stub,
      s => s.hasMessageItem(upToMessageId),
      'SessionIngestDO.hasMessageItem'
    );
    if (!hasCut) return { status: 'clone_cut_not_found' };
  }

  const stream = await withDORetry(
    stub,
    s => s.getAllStream(upToMessageId),
    'SessionIngestDO.getAllStream'
  );
  return { status: 'ok', stream };
}
