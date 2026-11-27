/**
 * Cloudflare Access service-token headers for the deployed e2e stack.
 *
 * Neither deployed e2e Worker has a public address. CI reaches the Worker's and
 * the fake LLM's custom domains through one Access application whose only
 * policy is Service Auth for one service token. The `tests` job reads the token
 * from the STS `ci-cloud-agent-e2e` bundle and passes it to the driver as
 * `E2E_ACCESS_CLIENT_ID` and `E2E_ACCESS_CLIENT_SECRET`; this is the only place
 * the driver reads them. The driver sends the token on requests to the
 * `WORKER_URL` origin (tRPC, `/stream`, the `/__e2e/*` surface) and the
 * `FAKE_LLM_URL` origin (the `/test/*` side channel), and registers it as the
 * headers of a callback target on the Worker's origin, because callback delivery
 * to the Worker's own origin passes the same Access application. A request to
 * any other origin, such as the backend, never carries it.
 *
 * Both variables unset adds nothing: the local profiles and a stack without an
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
  const target = origin(url);
  const accessOrigins = [env.WORKER_URL, env.FAKE_LLM_URL]
    .filter((value): value is string => Boolean(value))
    .map(origin);
  if (!accessOrigins.includes(target)) return {};
  return { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret };
}
