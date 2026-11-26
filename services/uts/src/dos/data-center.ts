/**
 * The Cloudflare data center this object runs in, from the edge trace of an outbound request, or
 * null when the trace does not answer within 2 seconds. A Durable Object never moves, so an object
 * asks once: a signer when it creates its first keys, a key-set shard when it first answers.
 */
export async function dataCenter(): Promise<string | null> {
  try {
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: AbortSignal.timeout(2000),
    });
    return /^colo=([A-Z]{3})$/m.exec(await response.text())?.[1] ?? null;
  } catch {
    return null;
  }
}
