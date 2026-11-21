import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { checkFirewallRateLimit, firewallRateLimitRefusal } from '@/lib/auth/firewall-rate-limit';
import {
  findOrganizationMembers,
  OrganizationMemberSearchQuerySchema,
} from '@/lib/organizations/organization-member-search';
import { isPagesAuthClient } from '@/lib/pages-auth/pages-auth-clients';
import { isPagesMemberSearchProofFor } from '@/lib/pages-auth/pages-member-search-proof';

/**
 * Vercel Firewall rules this route counts against. Both must exist in the
 * project's firewall configuration before Pages calls the route: a missing
 * rule answers 503.
 */
const DEPLOYMENT_RATE_LIMIT_ID = 'pages-member-search-deployment';
const SEARCHER_RATE_LIMIT_ID = 'pages-member-search-searcher';

const UserIdSchema = z.string().min(1).max(500);

const common = {
  audience: z.string().min(1).max(200),
  searcher_id: UserIdSchema,
  organization_id: z.uuid(),
  proof: z.string().min(1).max(4096),
};

const RequestSchema = z.union([
  z.object({ ...common, query: OrganizationMemberSearchQuerySchema }).strict(),
  z.object({ ...common, member_id: UserIdSchema }).strict(),
]);

function refuse(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Searches one organization's members, or confirms one member, for a person
 * signed in to a Pages deployment.
 *
 * A Pages deployment calls this from its server with its secret as a bearer
 * credential and one of:
 *
 *     { audience, searcher_id, organization_id, proof, query }
 *     { audience, searcher_id, organization_id, proof, member_id }
 *
 * `proof` is the `member_search_proof` from the searcher's exchange. `query`
 * is 2 to 100 characters after trimming and matches the start of any word of
 * a name. `member_id` resolves one pick at grant time, so Pages never grants an
 * id or name its browser sent.
 *
 * The answer is `{ "members": [{ "id", "name", "image_url" }] }`, at most 10,
 * and empty when nobody matches. `image_url` is null when the account has
 * none. Ids are raw Kilo user ids.
 *
 * Refusals, in the order they are checked: 400 `invalid_request` for a body
 * that is not exactly one of the shapes above; 401 `invalid_client` for a
 * caller that is not a configured deployment; 401 `invalid_proof` for a proof
 * that is forged, expired, or minted for another person or deployment; 403
 * `not_a_member` when the searcher's account is missing or blocked, or holds no
 * membership of its own in a live organization. 429 and 503 come from the rate
 * limits, per deployment before the proof is checked and per searcher after.
 */
export const POST = withRestTiming(
  '/api/pages-auth/organization-members',
  async (request: Request) => {
    const body: unknown = await request.json().catch(() => null);
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) return refuse(400, 'invalid_request');
    const input = parsed.data;
    const { audience, searcher_id: searcherId } = input;

    const secret = extractBearerToken(request.headers.get('authorization'));
    if (!isPagesAuthClient(audience, secret)) return refuse(401, 'invalid_client');

    const deploymentRefusal = firewallRateLimitRefusal(
      await checkFirewallRateLimit(DEPLOYMENT_RATE_LIMIT_ID, {
        source: 'pages_member_search_deployment',
        request,
        rateLimitKey: audience,
      })
    );
    if (deploymentRefusal) return deploymentRefusal;

    if (!isPagesMemberSearchProofFor(input.proof, { userId: searcherId, audience })) {
      return refuse(401, 'invalid_proof');
    }

    const searcherRefusal = firewallRateLimitRefusal(
      await checkFirewallRateLimit(SEARCHER_RATE_LIMIT_ID, {
        source: 'pages_member_search_searcher',
        request,
        rateLimitKey: `${audience}:${searcherId}`,
      })
    );
    if (searcherRefusal) return searcherRefusal;

    const members = await findOrganizationMembers(
      searcherId,
      input.organization_id,
      'query' in input ? { query: input.query } : { memberId: input.member_id }
    );
    if (!members) return refuse(403, 'not_a_member');

    return NextResponse.json({ members }, { headers: { 'Cache-Control': 'no-store' } });
  }
);
