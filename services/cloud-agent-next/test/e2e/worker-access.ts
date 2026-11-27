/**
 * Cloudflare Access service-token headers for the deployed e2e Worker.
 *
 * The deployed Worker has no public address. CI reaches its custom domain
 * through an Access application whose only policy is Service Auth for one
 * service token. The driver sends the token on every request to the Worker
 * origin (tRPC, `/stream`, the `/__e2e/*` surface) and registers it as the
 * callback target's headers, because callback delivery to the Worker's own
 * origin passes the same Access application. It is never sent to the backend or
 * the fake LLM.
 *
 * Both variables unset adds nothing: the local profiles and a Worker without an
 * Access hostname. Exactly one set is a configuration error.
 */
export function workerAccessHeaders(
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const clientId = env.E2E_ACCESS_CLIENT_ID || undefined;
  const clientSecret = env.E2E_ACCESS_CLIENT_SECRET || undefined;
  if (clientId === undefined && clientSecret === undefined) return {};
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error('Set both E2E_ACCESS_CLIENT_ID and E2E_ACCESS_CLIENT_SECRET, or neither.');
  }
  return { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret };
}
