/**
 * Web-side parser for the `metadata.wasteland` field on a bead. Mirrors the
 * canonical schema in `services/gastown/src/dos/town/wasteland-bead-origin.ts`
 * so the BeadPanel can render a deep link to the originating wanted item
 * without depending on the gastown service package.
 *
 * Keep this in sync with the gastown side. The shape is small and changes
 * rarely; duplicating the zod parser is cheaper than wiring up a shared
 * package across the apps/services boundary.
 */

import { z } from 'zod';

export const WastelandBeadOrigin = z.object({
  kind: z.enum(['wanted-item-claim']),
  wasteland_id: z.string().min(1),
  item_id: z.string().min(1),
  pull_id: z.string().min(1).nullable().optional(),
  source_url: z.string().url().nullable().optional(),
  reported_done_at: z.string().min(1).nullable().optional(),
  reported_evidence: z.string().min(1).nullable().optional(),
});
export type WastelandBeadOrigin = z.infer<typeof WastelandBeadOrigin>;

export function readWastelandBeadOrigin(
  metadata: Record<string, unknown> | null | undefined
): WastelandBeadOrigin | null {
  const raw = metadata?.wasteland;
  if (!raw || typeof raw !== 'object') return null;
  const parsed = WastelandBeadOrigin.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Build the deep link to the wanted item in the wasteland UI. Uses the
 * `?itemId=...` query param so the wanted-board page can auto-open the
 * drawer for that item on mount.
 *
 * When `pathname` includes an org-scoped segment, the link is routed
 * through the matching `/organizations/[id]/wasteland/...` tree so the
 * user stays inside the org's app shell.
 *
 * The personal-scope link goes through `/wasteland/by-id/{wastelandId}/wanted`,
 * the redirect page that resolves the wasteland's upstream server-side
 * and forwards to the canonical `/wasteland/{owner}/{repo}` URL,
 * preserving the `?itemId=` query. The bare `/wasteland/{wastelandId}/wanted`
 * URL would otherwise hit the `[owner]/[repo]` route with the id as the
 * owner segment and 404 — the bead origin metadata only carries the
 * wasteland UUID, not the upstream slug.
 */
export function buildWastelandItemHref(
  origin: Pick<WastelandBeadOrigin, 'wasteland_id' | 'item_id'>,
  pathname: string | null
): string {
  const orgMatch = pathname?.match(/^\/organizations\/([^/]+)\//);
  const base = orgMatch
    ? `/organizations/${orgMatch[1]}/wasteland/${origin.wasteland_id}/wanted`
    : `/wasteland/by-id/${origin.wasteland_id}/wanted`;
  return `${base}?itemId=${encodeURIComponent(origin.item_id)}`;
}
