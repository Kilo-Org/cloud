import 'server-only';

/**
 * The shared webhook body size limit, used by the Bitbucket integration route
 * and the bot platform webhook handlers.
 */
export const MAX_WEBHOOK_BODY_BYTES = 256_000;

export class WebhookBodyTooLargeError extends Error {}

/**
 * Reads a webhook request body up to MAX_WEBHOOK_BODY_BYTES. A content-length
 * above the limit throws before the body is read; otherwise the body is read
 * through a reader and throws once the total passes the limit.
 */
export async function readBoundedRawBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_WEBHOOK_BODY_BYTES)
  ) {
    throw new WebhookBodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The rejection applies even if the stream cannot be cancelled.
        }
        throw new WebhookBodyTooLargeError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
