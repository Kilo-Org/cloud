import * as z from 'zod';
import type {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { readAutoRoutingBenchmarkSecret } from './secrets';

const TokenResponseSchema = z.object({ token: z.string().min(1), expiresAt: z.string() });

/**
 * The one verifier a benchmark token is minted for. Each token goes only to routes that
 * verify that audience:
 * - `kilo-api`: the organization model catalog, `/api/organizations/<org>/models`.
 * - `kilo-gateway`: the gateway catalog reads the case proxy forwards
 *   (`/api/openrouter/models`, `/api/gateway/v1/models`) and the CLI container.
 */
export type BenchmarkTokenAudience = typeof KILO_API_AUDIENCE | typeof KILO_GATEWAY_AUDIENCE;

/**
 * The CLI run without the case proxy (`/admin/debug-cli`) sends its one key to the gateway
 * and to any `kilo-api` setup route it calls, and it cannot hold one token per audience.
 * That mint names no audience, so it keeps the shape every unsplit caller gets until
 * strict multi-audience refusal, which waits for a CLI that exchanges per audience.
 */
export const UNSPLIT_CLI_TOKEN = 'unsplit-cli';

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
  audience: BenchmarkTokenAudience | typeof UNSPLIT_CLI_TOKEN,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const secret = await readAutoRoutingBenchmarkSecret(env, 'BOT_TOKEN_MINT_SECRET');
  const response = await fetchImpl(new URL('/api/internal/bot-token', env.KILO_WEB_API_BASE_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(
      audience === UNSPLIT_CLI_TOKEN
        ? { userId, organizationId }
        : { userId, organizationId, audience }
    ),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`token mint failed: HTTP ${response.status}`);
  const parsedToken = TokenResponseSchema.safeParse(await response.json());
  if (!parsedToken.success) throw new Error('token mint returned unexpected response shape');
  return parsedToken.data.token;
}
