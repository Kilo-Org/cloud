const CLOSE_REASON_MAX_BYTES = 123;

/**
 * A close code a peer may send. 1005, 1006 and 1015 only report a close that
 * had no frame, and other codes outside the sendable ranges make `close()`
 * throw, so 1000 stands in for them.
 */
export function sendableCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if ((code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
  return 1000;
}

/** A close reason cut to the 123 bytes a close frame can carry, on a character boundary. */
export function sendableCloseReason(reason: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(reason).length <= CLOSE_REASON_MAX_BYTES) return reason;
  let kept = '';
  let bytes = 0;
  for (const char of reason) {
    bytes += encoder.encode(char).length;
    if (bytes > CLOSE_REASON_MAX_BYTES) break;
    kept += char;
  }
  return kept;
}

/** Closes with a sendable code and reason; a socket that already closed is left as it is. */
export function closeWebSocketQuietly(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(sendableCloseCode(code), sendableCloseReason(reason));
  } catch {
    // Already closed.
  }
}
