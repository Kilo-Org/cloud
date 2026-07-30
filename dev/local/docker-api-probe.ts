const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// A momentarily slow Docker daemon can miss a single probe window, which made
// dev:start refuse the shared docker-tcp bridge as a foreign port. Retry
// timeouts and connection errors before concluding the listener is not the
// Docker API; a definitive HTTP response with the wrong content is not
// retried — that listener is genuinely foreign.
export async function probeDockerApi(
  port: number,
  timeoutMs = 500,
  attempts = 3
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_ping`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return (
        response.status === 200 &&
        response.headers.has('api-version') &&
        (await response.text()).trim() === 'OK'
      );
    } catch {
      if (attempt >= attempts) return false;
      await sleep(250);
    }
  }
}
