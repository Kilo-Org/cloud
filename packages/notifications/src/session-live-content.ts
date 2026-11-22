import { z } from 'zod';
import { approvalKeySchema } from '@kilocode/app-shared/approval-key';
import {
  GLANCEABLE_STATUS_KINDS,
  GLANCEABLE_TITLE_LIMIT,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  SESSION_LIVE_COMMAND_LIMIT,
  sessionLiveChangesSchema,
  sessionLiveFailureSchema,
  sessionLivePlanSchema,
  sessionLiveStepSchema,
} from '@kilocode/session-ingest-contracts/session-live-summary';

import { nonEmptyStringSchema } from './non-empty-string';

/**
 * The card's own content beyond the ingest derivation contract: the
 * content-state schema the card renders, the outcome line and the quiet period.
 * The step, plan, changes and failure shapes come from
 * `@kilocode/session-ingest-contracts` and are imported from there, so there is
 * one definition of each.
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

/**
 * The card's status kinds: the shared glanceable vocabulary plus a turn that
 * failed. `pushDataSchema` validates a pushed `statusKind` against this list,
 * and the type derived from it types the kind the builder produces.
 */
export const SESSION_CARD_STATUS_KINDS = [...GLANCEABLE_STATUS_KINDS, 'failed'] as const;
export type SessionCardStatusKind = (typeof SESSION_CARD_STATUS_KINDS)[number];

/**
 * The card kinds that mean the turn finished: a quiet idle card or a failed
 * turn. The content builder and the relevance ranking share this one test, so a
 * new terminal kind changes both together.
 */
export function isFinishedSessionCardStatus(kind: SessionCardStatusKind): boolean {
  return kind === 'idle' || kind === 'failed';
}

/** How a finished session ended, for the outcome line. */
export const sessionLiveOutcomeKindSchema = z.enum(['pr_opened', 'changes', 'none']);
export type SessionLiveOutcomeKind = z.infer<typeof sessionLiveOutcomeKindSchema>;

export const sessionLiveOutcomeSchema = z.object({
  kind: sessionLiveOutcomeKindSchema,
});

/**
 * The content-state fields, declared apart from the schema below so the
 * cross-field refinement can read their types.
 */
const sessionLiveActivityContentStateShape = {
  sessionId: nonEmptyStringSchema,
  /** Trimmed and capped display title; null for an untitled session. */
  title: z.string().max(GLANCEABLE_TITLE_LIMIT).nullable(),
  statusKind: z.enum(SESSION_CARD_STATUS_KINDS),
  /** ISO 8601; when the current status kind began. */
  statusSince: z.string().datetime(),
  /** ISO 8601 wake time for a scheduled session, else null. */
  scheduledAt: z.string().datetime().nullable(),
  /**
   * True only when Approve can answer the waiting permission request, which is
   * exactly when `approvalKey` is present; the refinement below holds the two
   * together.
   */
  awaitingPermission: z.boolean(),
  /** SHA-256 hex of `JSON.stringify([sessionId, permissionId])`, else null. */
  approvalKey: approvalKeySchema,
  /** ISO 8601; when the server confirmed this content. */
  updatedAt: z.string().datetime(),
  /** The step the agent is on; null when the session is not working. */
  currentStep: sessionLiveStepSchema.nullable().optional(),
  /** Plan progress while the agent works from a todo list. */
  plan: sessionLivePlanSchema.nullable().optional(),
  /** The command Approve answers, trimmed to one line; null without one. */
  permissionCommand: z.string().max(SESSION_LIVE_COMMAND_LIMIT).nullable().optional(),
  /** The diff this session produced so far. */
  changes: sessionLiveChangesSchema.nullable().optional(),
  /** ISO 8601; the last activity the server saw. */
  lastActivityAt: z.string().datetime().nullable().optional(),
  /** The cost so far, in microdollars. */
  costMicrodollars: z.number().int().nonnegative().nullable().optional(),
  /** How a finished session ended. */
  outcome: sessionLiveOutcomeSchema.nullable().optional(),
  /** Why a finished turn failed; null while nothing failed. */
  failure: sessionLiveFailureSchema.nullable().optional(),
  /** ISO 8601; when the session started. */
  startedAt: z.string().datetime().nullable().optional(),
};

/** The shape's own type, so the refinement below reads the field types from the shape. */
const sessionLiveActivityContentStateShapeSchema = z.object(sessionLiveActivityContentStateShape);

/**
 * `awaitingPermission` states that Approve can answer the waiting request, and
 * `approvalKey` names that request. They answer one question, so a payload that
 * sets one without the other describes a card that cannot exist: Approve with
 * nothing to answer, or a request the card does not offer. The builder
 * (`buildSessionLiveActivityContentState`) derives the flag from the key, so
 * this check never rejects what the repository itself produces; it rejects a
 * payload assembled anywhere else.
 */
function refineAwaitingPermission(
  data: z.infer<typeof sessionLiveActivityContentStateShapeSchema>,
  ctx: z.RefinementCtx
): void {
  if (data.awaitingPermission !== (data.approvalKey !== null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['approvalKey'],
      message: 'approvalKey is present exactly when awaitingPermission is true',
    });
  }
}

/**
 * The raw content-state one followed session's Live Activity renders
 * (`.specs/mobile-session-live-activity.md`). Unlike the aggregate card, it
 * carries the session title: the user started the card with Follow. The
 * session id routes taps and approval and is never drawn. It must never carry
 * an organization name, repository, generated text, or a raw account id.
 *
 * A refined object cannot be reshaped: zod refuses `.pick`, `.omit`, `.partial`
 * and `.merge` on it, and `.extend` silently drops the refinement. Declare the
 * fields in `sessionLiveActivityContentStateShape` and build the schema from
 * that shape when a narrower or wider variant is needed.
 */
export const sessionLiveActivityContentStateSchema =
  sessionLiveActivityContentStateShapeSchema.superRefine(refineAwaitingPermission);

export type SessionLiveActivityContentState = z.infer<typeof sessionLiveActivityContentStateSchema>;

/**
 * How long a working session may show no activity before the card says so.
 * The Android renderer reads this constant through the package export; the
 * stringified iOS layout cannot import it and carries the same number, which
 * `session-live-activity.test.ts` holds it to.
 */
export const SESSION_CARD_QUIET_AFTER_MS = 5 * 60_000;
