import * as z from 'zod';

const TokenResponseSchema = z.object({ token: z.string().min(1), expiresAt: z.string() });

// Calls apps/web's internal bot-token endpoint to mint a short-lived token for
// the internal bot user the benchmark runs as. Never logs the token.
//
// `userId` and `organizationId` name the account and organization to mint for,
// and the endpoint checks that pair against its eligibility rule before it
// issues anything. The rule lives in apps/web/src/lib/bot-users/eligibility.ts,
// shared with the catalog mint:
// - the user id starts with `bot-internal-`, the account is `is_bot`, it is not
//   blocked, and it has a non-empty API-token pepper;
// - the bot holds an `owner` or `member` role in the requested organization.
// Humans and per-org product bots are refused, and a missing user, a missing
// membership, or any other role fails the request.
export async function fetchBenchmarkUserToken(
  env: Env,
  userId: string,
  organizationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const secret = await env.BOT_TOKEN_MINT_SECRET.get();
  const response = await fetchImpl(new URL('/api/internal/bot-token', env.KILO_WEB_API_BASE_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ userId, organizationId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`token mint failed: HTTP ${response.status}`);
  const parsedToken = TokenResponseSchema.safeParse(await response.json());
  if (!parsedToken.success) throw new Error('token mint returned unexpected response shape');
  return parsedToken.data.token;
}
