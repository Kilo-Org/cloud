import type { KilocodeEventData } from '../../shared/protocol.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KiloSessionCaptureContext = {
  updateKiloSessionId: (id: string) => Promise<void>;
  linkToBackend: (kiloSessionId: string) => Promise<void>;
  logger: {
    info: (msg: string, data?: object) => void;
    warn: (msg: string, data?: object) => void;
  };
};

export type KiloSessionCaptureState = {
  captured: boolean;
};

/**
 * Process a kilocode event and capture kiloSessionId if present.
 * Returns true if a session ID was captured.
 */
export async function handleKilocodeEvent(
  data: KilocodeEventData,
  state: KiloSessionCaptureState,
  ctx: KiloSessionCaptureContext
): Promise<boolean> {
  if (state.captured) return false;
  if (data.event !== 'session_created') return false;
  if (typeof data.sessionId !== 'string') return false;
  if (!UUID_REGEX.test(data.sessionId)) {
    ctx.logger.warn('Invalid kiloSessionId format', { sessionId: data.sessionId });
    return false;
  }

  state.captured = true;
  const kiloSessionId = data.sessionId;

  await ctx.updateKiloSessionId(kiloSessionId);
  ctx.logger.info('Captured kiloSessionId', { kiloSessionId });

  // Backend link is async/non-blocking
  void ctx.linkToBackend(kiloSessionId).catch(err => {
    ctx.logger.warn('Failed to link kiloSessionId to backend', {
      kiloSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return true;
}
