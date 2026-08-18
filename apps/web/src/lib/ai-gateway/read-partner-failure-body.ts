const PARTNER_FAILURE_BODY_LOG_LIMIT_BYTES = 16 * 1024;
const PARTNER_FAILURE_BODY_READ_TIMEOUT_MS = 5_000;

export async function readPartnerFailureBody(
  response: Response
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: '', truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytesRead = 0;

  try {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Partner response body read timed out')),
            PARTNER_FAILURE_BODY_READ_TIMEOUT_MS
          );
        }),
      ]).finally(() => clearTimeout(timeoutId));

      if (chunk.done) {
        body += decoder.decode();
        return { body, truncated: false };
      }

      const remainingBytes = PARTNER_FAILURE_BODY_LOG_LIMIT_BYTES - bytesRead;
      if (chunk.value.byteLength > remainingBytes) {
        body += decoder.decode(chunk.value.subarray(0, remainingBytes), { stream: true });
        body += decoder.decode();
        await reader.cancel();
        return { body, truncated: true };
      }

      bytesRead += chunk.value.byteLength;
      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the body read error when cancellation also fails.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
