import * as z from 'zod';

const TokenResponseSchema = z.object({ token: z.string().min(1), expiresAt: z.string() });

export async function fetchBenchmarkUserToken(
  env: Env,
  userId: string,
  organizationId: string | null = null,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  const response = await fetchImpl(
    new URL('/api/internal/auto-routing-benchmark/token', env.KILO_WEB_API_BASE_URL),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ userId, ...(organizationId ? { organizationId } : {}) }),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!response.ok) throw new Error(`token mint failed: HTTP ${response.status}`);
  const parsedToken = TokenResponseSchema.safeParse(await response.json());
  if (!parsedToken.success) throw new Error('token mint returned unexpected response shape');
  return parsedToken.data.token;
}
