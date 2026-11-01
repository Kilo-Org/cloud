/**
 * The wire shape of `wasteland.resolveOwnerRepo`.
 *
 * The address has always answered with one wasteland's identity, and a
 * browser bundle built before one address could reach several wastelands
 * reads exactly those fields. So the identity stays flat at the top
 * level and the chooser is additive: `candidates` lists every claimant
 * the caller reaches, in registry order, only when there is more than
 * one. A bundle that predates the chooser opens `wastelandId`; a bundle
 * that knows `candidates` shows the chooser first.
 *
 * Both directions have to stay readable because the web app is promoted
 * before this worker deploys, and a page that is already open keeps its
 * old bundle after the worker deploys.
 *
 * The shape lives here, away from `router.ts`, so unit tests can pin it
 * without pulling the Cloudflare runtime into the import graph.
 */

import { z } from 'zod';
import type { ResolvedWasteland, WastelandResolution } from './resolve-wasteland';

/** One wasteland a caller can reach through an upstream address. */
export const OwnerRepoWasteland = z.object({
  wastelandId: z.string(),
  ownerType: z.enum(['user', 'org']),
  ownerUserId: z.string().nullable(),
  organizationId: z.string().nullable(),
  name: z.string(),
});

export type OwnerRepoWasteland = z.infer<typeof OwnerRepoWasteland>;

/**
 * The identity to open, plus every claimant when the caller reaches more
 * than one. `null` means the caller reaches nothing at this address,
 * which is answered exactly like an unregistered one.
 */
export const OwnerRepoAnswer = OwnerRepoWasteland.extend({
  candidates: z.array(OwnerRepoWasteland).optional(),
}).nullable();

export type OwnerRepoAnswer = z.infer<typeof OwnerRepoAnswer>;

function identity(wasteland: ResolvedWasteland): OwnerRepoWasteland {
  return {
    wastelandId: wasteland.wastelandId,
    ownerType: wasteland.ownerType,
    ownerUserId: wasteland.ownerUserId,
    organizationId: wasteland.organizationId,
    name: wasteland.name,
  };
}

/**
 * Project the resolver's own result onto the wire. For several claimants
 * the flat identity is the first one in registry order — the same
 * deterministic order the candidates arrive in, never registration or
 * backfill recency.
 */
export function toOwnerRepoAnswer(resolution: WastelandResolution): OwnerRepoAnswer {
  if (resolution.kind === 'none') return null;
  if (resolution.kind === 'resolved') return identity(resolution.wasteland);
  const candidates = resolution.candidates.map(identity);
  return { ...candidates[0], candidates };
}
