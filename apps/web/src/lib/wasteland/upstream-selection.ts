/**
 * The answer `wasteland.resolveOwnerRepo` gives for an `<owner>/<repo>`
 * address, and the decision the `/wasteland/:owner/:repo` shell makes
 * from it.
 *
 * The answer carries one wasteland's identity flat, and adds
 * `candidates` only when this caller reaches more than one wasteland for
 * the same upstream. A worker deployed before that field existed answers
 * only the identity, so it is read from the top level rather than from a
 * nested envelope: one bundle serves both worker versions, in either
 * deployment order.
 */

/** One wasteland a caller can reach through an upstream address. */
export type UpstreamWasteland = {
  wastelandId: string;
  ownerType: 'user' | 'org';
  ownerUserId: string | null;
  organizationId: string | null;
  name: string;
};

/**
 * The address answer: the identity to open, plus every claimant when the
 * caller reaches several. `null` (answered by the procedure) means none.
 */
export type UpstreamAnswer = UpstreamWasteland & { candidates?: UpstreamWasteland[] };

export type UpstreamSelection =
  | { kind: 'open'; wasteland: UpstreamWasteland }
  | { kind: 'choose'; candidates: UpstreamWasteland[] };

/**
 * Decide what the shell renders: one wasteland, or the chooser.
 *
 * `selectedWastelandId` is the `?wastelandId=` already in the address. It
 * selects one of the candidates the answer lists; when it does not name
 * one of them, the shell shows the chooser.
 */
export function selectUpstreamWasteland(
  answer: UpstreamAnswer,
  selectedWastelandId: string | null
): UpstreamSelection {
  const { candidates, ...wasteland } = answer;
  if (!candidates) return { kind: 'open', wasteland };

  const chosen = candidates.find(candidate => candidate.wastelandId === selectedWastelandId);
  return chosen ? { kind: 'open', wasteland: chosen } : { kind: 'choose', candidates };
}
