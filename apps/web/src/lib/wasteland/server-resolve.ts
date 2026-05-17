import 'server-only';
import type { User } from '@kilocode/db/schema';
import { createTRPCClient, httpLink } from '@trpc/client';
import type { WrappedWastelandRouter } from '@/lib/wasteland/types/router';
import { WASTELAND_URL } from '@/lib/constants';
import { generateApiToken } from '@/lib/tokens';
import { getUserOrgMemberships } from '@/lib/organizations/organizations';
import { parseDolthubUpstream } from '@/lib/wasteland/upstream';

/**
 * Server-side resolver: given a user and a wastelandId, fetch the wasteland's
 * `dolthub_upstream` slug from the worker and return the parsed `{owner, repo}`
 * pair so legacy UUID-keyed routes can redirect to the M2.2 owner/repo URLs.
 *
 * Returns `null` when the wasteland can't be found, isn't accessible, or has
 * no upstream configured. Callers fall through to the legacy UI in that case
 * (it remains reachable via the next.config.mjs rewrite that maps
 * `/wasteland/<uuid>/...` → `/wasteland/by-id/<uuid>/...`).
 *
 * Failures are swallowed to `null` on purpose — a redirect lookup that 500s
 * would block the user from seeing anything at all.
 */
export async function resolveWastelandUpstreamForUser(
  user: User,
  wastelandId: string
): Promise<{ owner: string; repo: string } | null> {
  if (!WASTELAND_URL) return null;

  try {
    const orgMemberships = await getUserOrgMemberships(user.id);
    const token = generateApiToken(
      user,
      { isAdmin: user.is_admin, orgMemberships },
      { expiresIn: 60 * 5 }
    );

    const client = createTRPCClient<WrappedWastelandRouter>({
      links: [
        httpLink({
          url: `${WASTELAND_URL}/trpc`,
          headers: { Authorization: `Bearer ${token}` },
        }),
      ],
    });

    const wasteland = await client.wasteland.getWasteland.query({ wastelandId });
    return parseDolthubUpstream(wasteland.dolthub_upstream);
  } catch {
    return null;
  }
}
