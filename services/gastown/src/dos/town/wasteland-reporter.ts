/**
 * Pure helpers for the wasteland auto-done reconciler pass.
 *
 * Given the set of beads that carry `metadata.wasteland.item_id`, these
 * helpers determine:
 *   - which item_ids have reached "merged" status (every wasteland-tagged
 *     MR bead for the claim is closed)
 *   - which bead is the canonical place to stamp `reported_done_at` on
 *     (convoy bead if any, else the single tagged issue bead)
 *   - what evidence string to send upstream (markdown list of merged PRs)
 *
 * No DO/SQL access — everything is computed from rows the reconciler
 * already loads.
 */

import { readWastelandBeadOrigin } from './wasteland-bead-origin';
import type { WastelandBeadOrigin } from './wasteland-bead-origin';

/** Minimal bead shape consumed by this module. */
export type ReporterBead = {
  bead_id: string;
  type: string;
  status: string;
  title: string;
  metadata: Record<string, unknown>;
  /** PR URL joined from `review_metadata` (only present for merge_request beads). */
  pr_url?: string | null;
  created_at: string;
};

export type ReporterClaim = {
  wasteland_id: string;
  item_id: string;
  /** All beads that carry the same wasteland item_id, in stable created-order. */
  beads: ReporterBead[];
  /** The canonical bead the reporter stamps `reported_done_at` on. Never null. */
  canonical_bead_id: string;
  /** The wasteland origin tag pulled from the canonical bead. */
  origin: WastelandBeadOrigin;
};

/**
 * Group beads by wasteland item_id. Beads without a valid origin tag are
 * silently skipped. Within a claim, beads are ordered by created_at (oldest
 * first) so the canonical-bead pick is stable across ticks.
 */
export function groupBeadsByWastelandClaim(beads: ReporterBead[]): ReporterClaim[] {
  const byItem = new Map<string, ReporterBead[]>();
  for (const b of beads) {
    const origin = readWastelandBeadOrigin(b.metadata);
    if (!origin) continue;
    const key = `${origin.wasteland_id}::${origin.item_id}`;
    const existing = byItem.get(key);
    if (existing) {
      existing.push(b);
    } else {
      byItem.set(key, [b]);
    }
  }

  const claims: ReporterClaim[] = [];
  for (const group of byItem.values()) {
    const sorted = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const canonical = pickCanonicalBead(sorted);
    if (!canonical) continue;
    const origin = readWastelandBeadOrigin(canonical.metadata);
    if (!origin) continue;
    claims.push({
      wasteland_id: origin.wasteland_id,
      item_id: origin.item_id,
      beads: sorted,
      canonical_bead_id: canonical.bead_id,
      origin,
    });
  }
  return claims;
}

/**
 * Pick the canonical bead for a claim. Rules, in order:
 *   1. If any bead has type=`convoy`, that one wins (convoy beads are the
 *      natural single-aggregator for a multi-bead claim).
 *   2. Otherwise the first bead by `created_at`.
 * Returns null only when the input array is empty.
 */
export function pickCanonicalBead(beads: ReporterBead[]): ReporterBead | null {
  if (beads.length === 0) return null;
  const convoy = beads.find(b => b.type === 'convoy');
  if (convoy) return convoy;
  return beads[0];
}

export type ClaimStatus =
  | { kind: 'merged'; merged_pr_urls: ReadonlyArray<{ url: string; title: string }> }
  | { kind: 'failed' }
  | { kind: 'in-flight' };

/**
 * Compute the wasteland-side status of a claim from the bead set.
 *
 * Strict-all rule:
 *   - merged: every tagged MR bead is in a terminal state (closed or
 *     failed) AND at least one MR is closed. Failed MRs are tolerated —
 *     they just don't contribute evidence rows. (Rationale: "≥1 PR
 *     landed AND nothing is still in flight" is what users mean by
 *     "the wanted item got delivered.")
 *   - failed: every tagged MR bead is in a terminal state, none merged.
 *     The wasteland API has no "failed" channel today; callers do
 *     nothing with this state, but it's distinct from in-flight so
 *     audit/debug surfaces can show "this claim ended without delivery".
 *   - in-flight: anything else (an MR is still open/in-progress, no MR
 *     exists yet, or — when a convoy bead is in the set — the convoy
 *     itself hasn't closed).
 *
 * "Tagged MR beads" are merge_request beads in the claim set. Issue
 * beads in the set don't get evaluated directly — their MR descendants
 * carry the merge state.
 */
export function computeClaimStatus(claim: ReporterClaim): ClaimStatus {
  const mrs = claim.beads.filter(b => b.type === 'merge_request');
  if (mrs.length === 0) return { kind: 'in-flight' };

  const allTerminal = mrs.every(mr => mr.status === 'closed' || mr.status === 'failed');
  if (!allTerminal) return { kind: 'in-flight' };

  const merged = mrs.filter(mr => mr.status === 'closed');
  if (merged.length === 0) return { kind: 'failed' };

  // Convoy gating: if a convoy bead is in the set, it must also be closed
  // before we report. This is the review-then-land case where every task
  // bead can be merged into the feature branch but the final landing PR
  // is what actually puts code on main.
  const convoy = claim.beads.find(b => b.type === 'convoy');
  if (convoy && convoy.status !== 'closed') return { kind: 'in-flight' };

  // Build evidence list from the merged MRs that have a pr_url.
  const pickPr = (mr: ReporterBead): { url: string; title: string } | null => {
    if (!mr.pr_url) return null;
    return { url: mr.pr_url, title: mr.title };
  };
  const merged_pr_urls: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const mr of merged) {
    const pr = pickPr(mr);
    if (!pr) continue;
    if (seen.has(pr.url)) continue;
    seen.add(pr.url);
    merged_pr_urls.push(pr);
  }

  return { kind: 'merged', merged_pr_urls };
}

/**
 * Build the human-readable evidence string sent upstream to wasteland.
 * Markdown list of merged PRs with their bead titles. Falls back to a
 * minimal note when no PR URLs are available (rare, but possible if the
 * bead carries the wasteland tag without going through the MR path).
 */
export function buildEvidence(
  status: Extract<ClaimStatus, { kind: 'merged' }>,
  fallbackTitle: string
): string {
  if (status.merged_pr_urls.length === 0) {
    return `Marked done by gastown auto-reporter for "${fallbackTitle}". No PR URLs were available on the merged review beads.`;
  }
  if (status.merged_pr_urls.length === 1) {
    const pr = status.merged_pr_urls[0];
    return `Implemented by ${pr.url} (${pr.title}).`;
  }
  const lines = status.merged_pr_urls.map(pr => `- ${pr.url} (${pr.title})`);
  return `Implemented by:\n${lines.join('\n')}`;
}

/** Has the canonical bead already been reported done? Idempotency gate. */
export function isAlreadyReported(claim: ReporterClaim): boolean {
  return typeof claim.origin.reported_done_at === 'string' && claim.origin.reported_done_at !== '';
}
