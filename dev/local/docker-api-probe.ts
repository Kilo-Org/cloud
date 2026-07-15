export async function probeDockerApi(port: number, timeoutMs = 500): Promise<boolean> {
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
    return false;
  }
}
