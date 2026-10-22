import {
  SESSION_LIVE_COMMAND_LIMIT,
  SESSION_LIVE_FAILURE_KINDS,
  SESSION_LIVE_PLAN_STEP_LIMIT,
  SESSION_LIVE_STEP_VERBS,
  SESSION_LIVE_TARGET_LIMIT,
  sessionLiveChangesSchema,
  sessionLiveFailureSchema,
  sessionLivePlanSchema,
  sessionLiveStepSchema,
  type SessionLiveChanges,
  type SessionLiveFailure,
  type SessionLiveFailureKind,
  type SessionLivePlan,
  type SessionLiveStep,
  type SessionLiveStepVerb,
} from '@kilocode/session-ingest-contracts';
import { z } from 'zod';

/**
 * The richer facts of one followed session that its Live Activity shows
 * (`.specs/mobile-session-live-activity.md` "Card data contract"). The shapes
 * come from the ingest derivation contract, so the card, the stored summary,
 * and the derivation cannot disagree.
 *
 * They are OPTIONAL in the content state so a card built by an older producer
 * still parses, and so the layout never depends on a field a push did not
 * carry.
 *
 * Privacy: the step target, the plan step name, and `permissionCommand` are
 * the only request text any glanceable surface carries, and each one is
 * trimmed to a single short line by the producer. Free-form assistant text
 * never appears here.
 */

export {
  SESSION_LIVE_COMMAND_LIMIT,
  SESSION_LIVE_FAILURE_KINDS,
  SESSION_LIVE_PLAN_STEP_LIMIT,
  SESSION_LIVE_STEP_VERBS,
  SESSION_LIVE_TARGET_LIMIT,
  sessionLiveChangesSchema,
  sessionLiveFailureSchema,
  sessionLivePlanSchema,
  sessionLiveStepSchema,
  type SessionLiveChanges,
  type SessionLiveFailure,
  type SessionLiveFailureKind,
  type SessionLivePlan,
  type SessionLiveStep,
  type SessionLiveStepVerb,
};

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
