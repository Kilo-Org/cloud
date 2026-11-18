const CLOSE_REASON_MAX_BYTES = 123;

/**
 * A close code a peer may send. 1005, 1006 and 1015 only report a close that
 * had no frame, and other codes outside the sendable ranges make `close()`
 * throw, so 1000 stands in for them.
 */
function sendableCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if ((code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
  return 1000;
}

function sendableCloseReason(reason: string): string {
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

/** A peer that already closed makes `close()` throw; the bridge only needs it closed. */
function closeQuietly(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(sendableCloseCode(code), sendableCloseReason(reason));
  } catch {
    // Already closed.
  }
}

async function messageData(event: MessageEvent): Promise<string | ArrayBuffer> {
  const raw: unknown = event.data;
  return raw instanceof Blob ? raw.arrayBuffer() : (raw as string | ArrayBuffer);
}

/**
 * Forwards one direction in arrival order. A binary frame can arrive as a Blob,
 * which converts asynchronously, so each send waits for the one before it.
 */
function forwardMessages(from: WebSocket, to: WebSocket, failureReason: string): void {
  let previous: Promise<void> = Promise.resolve();
  from.addEventListener('message', event => {
    previous = previous
      .then(async () => {
        to.send(await messageData(event));
      })
      .catch(() => closeQuietly(from, 1011, failureReason));
  });
}

/** Joins the browser-facing socket and the container socket until either side closes. */
export function bridgeSockets(browser: WebSocket, container: WebSocket): void {
  container.accept();
  browser.accept();
  forwardMessages(browser, container, 'Failed to forward message to container');
  forwardMessages(container, browser, 'Failed to forward message to client');
  browser.addEventListener('close', event => closeQuietly(container, event.code, event.reason));
  container.addEventListener('close', event => closeQuietly(browser, event.code, event.reason));
  browser.addEventListener('error', () => closeQuietly(container, 1011, 'Client WebSocket error'));
  container.addEventListener('error', () =>
    closeQuietly(browser, 1011, 'Container WebSocket error')
  );
}
