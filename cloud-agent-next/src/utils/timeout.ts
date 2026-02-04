/**
 * Wraps an async operation with a timeout.
 *
 * Pattern adopted from VibeSDK for reliable timeout protection.
 * The finally block ensures cleanup happens in all paths (success, timeout, error).
 *
 * @param operation The promise to execute
 * @param timeoutMs Timeout in milliseconds
 * @param errorMsg Error message to throw on timeout
 * @param onTimeout Optional callback to invoke when timeout occurs
 * @returns The result of the operation
 * @throws Error with errorMsg if timeout is exceeded
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  errorMsg: string,
  onTimeout?: () => void
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(new Error(errorMsg));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
