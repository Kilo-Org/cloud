import { z } from 'zod';

/**
 * The card's own content beyond the ingest derivation contract: the outcome
 * line and the quiet period. The step, plan, changes and failure shapes come
 * from `@kilocode/session-ingest-contracts` and are imported from there, so
 * there is one definition of each.
 *
 * The contract shapes are OPTIONAL in the content state so a card built by an
 * older producer still parses, and so the layout never depends on a field a
 * push did not carry.
 *
 * Privacy: the step target, the plan step name, and `permissionCommand` are
 * the only request text any glanceable surface carries, and each one is
 * trimmed to a single short line by the producer. Free-form assistant text
 * never appears here.
 */

/** How a finished session ended, for the outcome line. */
export const sessionLiveOutcomeKindSchema = z.enum(['pr_opened', 'changes', 'none']);
export type SessionLiveOutcomeKind = z.infer<typeof sessionLiveOutcomeKindSchema>;

export const sessionLiveOutcomeSchema = z.object({
  kind: sessionLiveOutcomeKindSchema,
});

/**
 * How long a working session may show no activity before the card says so.
 * The Android renderer reads this constant through the package export; the
 * stringified iOS layout cannot import it and carries the same number, which
 * `session-live-activity.test.ts` holds it to.
 */
export const SESSION_CARD_QUIET_AFTER_MS = 5 * 60_000;
