/**
 * Cloudflare Access service-token headers for the deployed e2e Worker.
 *
 * The deployed Worker has no public address. CI reaches its custom domain
 * through an Access application whose only policy is Service Auth for one
 * service token. The driver sends the token on requests to the `WORKER_URL`
 * origin (tRPC, `/stream`, the `/__e2e/*` surface) and registers it as the
 * headers of a callback target on that origin, because callback delivery to the
 * Worker's own origin passes the same Access application. A request to any other
 * origin, such as the backend or the fake LLM, never carries it.
 *
 * Both variables unset adds nothing: the local profiles and a Worker without an
 * Access hostname. Exactly one set is a configuration error.
 */
export function workerAccessHeaders(
  url: string,
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const clientId = env.E2E_ACCESS_CLIENT_ID || undefined;
  const clientSecret = env.E2E_ACCESS_CLIENT_SECRET || undefined;
  if (clientId === undefined && clientSecret === undefined) return {};
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error('Set both E2E_ACCESS_CLIENT_ID and E2E_ACCESS_CLIENT_SECRET, or neither.');
  }
  // `ws:`/`wss:` and `http:`/`https:` URLs of one host share an origin here.
  const origin = (value: string) => new URL(value.replace(/^ws(s?):/i, 'http$1:')).origin;
  if (!env.WORKER_URL || origin(url) !== origin(env.WORKER_URL)) return {};
  return { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret };
}
