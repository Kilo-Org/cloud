import { toHex } from './hex';
import { fail, ok, type Result, type SyncError } from './protocol';

/**
 * Streams a request body into R2 without buffering it. The stream hashes and
 * counts each chunk; a wrong length or hash, or a missed deadline, errors the
 * stream before it ends, so R2 never stores the object. R2 also checks the
 * declared SHA-256.
 */
export async function uploadBlob(
  bucket: R2Bucket,
  target: { key: string; deadline: number },
  body: ReadableStream<Uint8Array>,
  hash: string,
  bytes: number
): Promise<Result<null>> {
  const digest = new crypto.DigestStream('SHA-256');
  const writer = digest.getWriter();
  let received = 0;
  let failure: SyncError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const verify = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      timer = setTimeout(
        () => {
          failure = { code: 'upload_timeout', message: 'The upload did not finish in time' };
          controller.error(new Error(failure.message));
        },
        Math.max(0, target.deadline - Date.now())
      );
    },
    async transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > bytes) {
        failure = { code: 'invalid_request', message: 'The body is longer than Content-Length' };
        throw new Error(failure.message);
      }
      await writer.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      clearTimeout(timer);
      if (received !== bytes) {
        failure = { code: 'invalid_request', message: 'The body is shorter than Content-Length' };
        throw new Error(failure.message);
      }
      await writer.close();
      if (toHex(await digest.digest) !== hash) {
        failure = {
          code: 'blob_hash_mismatch',
          message: 'The body does not match its SHA-256 hash',
        };
        throw new Error(failure.message);
      }
    },
  });

  try {
    await bucket.put(
      target.key,
      body.pipeThrough(verify).pipeThrough(new FixedLengthStream(bytes)),
      { sha256: hash, httpMetadata: { contentType: 'application/octet-stream' } }
    );
    return ok(null);
  } catch (error) {
    if (failure) return fail(failure.code, failure.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
