import { cloudAgentSessionIdSchema } from '@kilocode/session-ingest-contracts';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

/** What the compute-billing router records for one session. */
export type SessionComputeCharges =
  inferRouterOutputs<MobileRouter>['computeBilling']['sessionCharges'];

/** One current compute rate from the billing catalogue. */
export type SessionComputeRate =
  inferRouterOutputs<MobileRouter>['computeBilling']['rates'][number];

/** One charged sandbox run of the session, as the session sheet lists it. */
export type SessionComputeRun = SessionComputeCharges['runs'][number];

/**
 * Compute reads and previews are addressed by a Cloud Agent session id, and
 * those carry the `workspace_` prefix. A session stored before that shape keeps
 * the id it was created with, so its compute and preview reads are skipped
 * instead of turning every open into a validation failure.
 */
export function isCloudAgentSessionId(value: unknown): value is `workspace_${string}` {
  return cloudAgentSessionIdSchema.safeParse(value).success;
}

/** The session's compute amount in microdollars, or null when none is recorded. */
export function computeChargesMicrodollars(
  charges: Pick<SessionComputeCharges, 'amountMicrodollars'> | undefined
): number | null {
  if (charges === undefined || !Number.isFinite(charges.amountMicrodollars)) {
    return null;
  }
  return charges.amountMicrodollars;
}

/**
 * The one total a surface paints: the recorded model cost plus the recorded
 * compute charges. A side that has recorded nothing does not erase the other,
 * and both unknown collapses to null so the surface paints no total at all.
 */
export function sessionTotalMicrodollars(
  modelMicrodollars: number | null,
  computeMicrodollars: number | null
): number | null {
  if (computeMicrodollars === null) {
    return modelMicrodollars;
  }
  if (modelMicrodollars === null) {
    return computeMicrodollars;
  }
  return modelMicrodollars + computeMicrodollars;
}
