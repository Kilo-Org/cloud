import * as z from 'zod';

const TokenResponseSchema = z.object({ token: z.string().min(1), expiresAt: z.string() });

// Calls apps/web's internal bot-token endpoint to mint a short-lived token for
// the internal bot user the benchmark runs as. Never logs the token.
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
