import { closeWebSocketQuietly as closeQuietly } from '../shared/websocket-close.js';

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
