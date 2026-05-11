/**
 * Schema and helpers for the `metadata.wasteland` field on beads created in
 * response to a wasteland event (claim, post, etc.).
 *
 * This file is the single source of truth for the shape of the wasteland
 * origin tag. It is imported both by the gastown handler that writes the
 * tag onto new beads and by the apps/web BeadPanel UI that reads it back
 * to render a deep link into the wasteland UI.
 */

import { z } from 'zod';

/**
 * The kind of wasteland event that produced the bead. Currently only
 * `wanted-item-claim` exists; new kinds get added here as we wire up
 * `post`, `done`, inbox accept/reject, etc.
 */
export const WastelandBeadOriginKind = z.enum(['wanted-item-claim']);
export type WastelandBeadOriginKind = z.infer<typeof WastelandBeadOriginKind>;

/**
 * Metadata payload stored at `bead.metadata.wasteland`. Persisted as JSON
 * inside the bead's `metadata` blob — there is no dedicated column.
 *
 * `pull_id` is set when the upstream claim path created an upstream PR
 * (the non-direct path in `claimWantedItem`). It is null for direct claims
 * by upstream admins.
 *
 * `reported_done_at` and `reported_evidence` are stamped onto the
 * "canonical" bead for a claim (the convoy bead if any, else the single
 * task bead) once gastown has called `WASTELAND_SERVICE.markWantedItemDone`
 * on its behalf. Their presence is the idempotency gate for the auto-done
 * reconciler pass — once set, the claim is never reported again.
 */
export const WastelandBeadOrigin = z.object({
  kind: WastelandBeadOriginKind,
  wasteland_id: z.string().min(1),
  item_id: z.string().min(1),
  pull_id: z.string().min(1).nullable().optional(),
  source_url: z.string().url().nullable().optional(),
  reported_done_at: z.string().min(1).nullable().optional(),
  reported_evidence: z.string().min(1).nullable().optional(),
});
export type WastelandBeadOrigin = z.infer<typeof WastelandBeadOrigin>;

/**
 * Read a `WastelandBeadOrigin` off an arbitrary bead metadata blob. Returns
 * null when the field is absent or malformed — callers treat the bead as
 * non-wasteland-linked in that case rather than throwing.
 */
export function readWastelandBeadOrigin(
  metadata: Record<string, unknown> | null | undefined
): WastelandBeadOrigin | null {
  const raw = metadata?.wasteland;
  if (!raw || typeof raw !== 'object') return null;
  const parsed = WastelandBeadOrigin.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
