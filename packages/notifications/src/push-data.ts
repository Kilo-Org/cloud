import { z } from 'zod';
import { homeWidgetDetailsSchema } from '@kilocode/app-shared/home-widget';

import { NEEDS_INPUT_ATTENTION_KINDS } from './needs-input-actions';
import {
  instanceLifecycleEventSchema,
  scheduledActionEventSchema,
  securityLifecycleEventSchema,
} from './notification-events';
import {
  SESSION_LIVE_COMMAND_LIMIT,
  sessionLiveChangesSchema,
  sessionLiveFailureSchema,
  sessionLiveOutcomeSchema,
  sessionLivePlanSchema,
  sessionLiveStepSchema,
} from './session-live-content';

const nonEmptyStringSchema = z.string().min(1);

// Discriminates between attention-requiring and status-only cloud agent
// session notifications. Optional everywhere it appears so old producers
// in a rolling deploy still validate; the default ('status') is applied
// at the enforcement read site.
export const cloudAgentSessionCategorySchema = z.enum(['attention', 'status']);
export type CloudAgentSessionCategory = z.infer<typeof cloudAgentSessionCategorySchema>;

/**
 * The raw content-state one followed session's Live Activity renders
 * (`.specs/mobile-session-live-activity.md`). Unlike the aggregate card, it
 * carries the session title: the user started the card with Follow. The
 * session id routes taps and approval and is never drawn. It must never carry
 * an organization name, repository, generated text, or a raw account id.
 */
export const sessionLiveActivityContentStateSchema = z.object({
  sessionId: nonEmptyStringSchema,
  /** Trimmed and capped display title; null for an untitled session. */
  title: z.string().max(120).nullable(),
  statusKind: z.enum(['needsInput', 'running', 'idle', 'scheduled', 'failed']),
  /** ISO 8601; when the current status kind began. */
  statusSince: z.string(),
  /** ISO 8601 wake time for a scheduled session, else null. */
  scheduledAt: z.string().nullable(),
  /** True only when Approve can answer the waiting permission request. */
  awaitingPermission: z.boolean(),
  /** SHA-256 hex of `JSON.stringify([sessionId, permissionId])`, else null. */
  approvalKey: z.string().nullable(),
  /** ISO 8601; when the server confirmed this content. */
  updatedAt: z.string(),
  /** The step the agent is on; null when the session is not working. */
  currentStep: sessionLiveStepSchema.nullable().optional(),
  /** Plan progress while the agent works from a todo list. */
  plan: sessionLivePlanSchema.nullable().optional(),
  /** The command Approve answers, trimmed to one line; null without one. */
  permissionCommand: z.string().max(SESSION_LIVE_COMMAND_LIMIT).nullable().optional(),
  /** The diff this session produced so far. */
  changes: sessionLiveChangesSchema.nullable().optional(),
  /** ISO 8601; the last activity the server saw. */
  lastActivityAt: z.string().nullable().optional(),
  /** The cost so far, in microdollars. */
  costMicrodollars: z.number().int().nonnegative().nullable().optional(),
  /** How a finished session ended. */
  outcome: sessionLiveOutcomeSchema.nullable().optional(),
  /** Why a finished turn failed; null while nothing failed. */
  failure: sessionLiveFailureSchema.nullable().optional(),
  /** ISO 8601; when the session started. */
  startedAt: z.string().nullable().optional(),
});

export type SessionLiveActivityContentState = z.infer<typeof sessionLiveActivityContentStateSchema>;

/**
 * Schema for the `data` blob attached to Expo push notifications.
 * This crosses the OS boundary as untyped JSON, so it MUST be
 * Zod-parsed by the mobile notification handler before use.
 */
export const pushDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat.message'),
    sandboxId: nonEmptyStringSchema,
    conversationId: nonEmptyStringSchema,
    messageId: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('instance-lifecycle'),
    event: instanceLifecycleEventSchema,
    sandboxId: z.string().min(1),
  }),
  z.object({
    type: z.literal('scheduled-action'),
    event: scheduledActionEventSchema,
    sandboxId: z.string().min(1),
  }),
  z.object({
    type: z.literal('cloud_agent_session'),
    cliSessionId: nonEmptyStringSchema,
    category: cloudAgentSessionCategorySchema.optional(),
    // Needs-input raise detail: which answer the waiting agent wants, and the
    // PR that can be opened from the notification. Absent on status pushes.
    attentionKind: z.enum(NEEDS_INPUT_ATTENTION_KINDS).optional(),
    prUrl: z.string().optional(),
    // The session's organization, so a tap can land the app in the context
    // the session belongs to. Optional so a push from an older producer in a
    // rolling deploy still validates; absent means Personal.
    organizationId: nonEmptyStringSchema.optional(),
  }),
  z.object({
    type: z.literal('agent_briefing'),
    url: z.literal('/agent-briefing'),
  }),
  z.object({
    type: z.literal('low_balance'),
    organizationId: nonEmptyStringSchema,
  }),
  // Spend alert push. Carries the owner scope and its id only — never an
  // amount, an email, or the configured threshold: this blob crosses the OS
  // lock screen, so the generic preview copy above must stay content-free.
  z.object({
    type: z.literal('spend_alert'),
    scope: z.enum(['personal', 'organization']),
    organizationId: nonEmptyStringSchema.optional(),
  }),
  z.object({
    type: z.literal('security_finding'),
    findingId: nonEmptyStringSchema,
    scope: nonEmptyStringSchema,
  }),
  // 1:1 map to SecurityAuditLogAction, shared with the internal dispatch
  // request schema: see SECURITY_LIFECYCLE_EVENTS in `notification-events.ts`
  // for the event-to-action mapping and the FindingCreated rationale.
  z.object({
    type: z.literal('security_lifecycle'),
    event: securityLifecycleEventSchema,
    findingId: nonEmptyStringSchema,
    scope: nonEmptyStringSchema,
    remediationId: nonEmptyStringSchema.optional(),
    prUrl: nonEmptyStringSchema.optional(),
  }),
  // Aggregate snapshot remains privacy-minimal. Optional Home-only details
  // travel beside it for background Home widget updates and are never copied
  // into Live Activity/ongoing content-state. Older producers omit them.
  z.object({
    type: z.literal('active_agents_glanceable'),
    schemaVersion: z.literal(1),
    revision: z.number().int().min(1),
    scopeKey: nonEmptyStringSchema,
    organizationBound: z.boolean(),
    status: z.enum(['waiting', 'empty', 'happy', 'stale', 'expired', 'signed_out', 'privacy']),
    running: z.number().int().min(0),
    needsInput: z.number().int().min(0),
    /**
     * Needs-input rows waiting on a permission prompt: the ones the wrist can
     * approve. Optional on input with a zero default so a push from a server
     * older than this release still parses.
     */
    needsApproval: z.number().int().min(0).default(0),
    idle: z.number().int().min(0),
    /**
     * Sessions scheduled to wake later. Optional on input with a zero default
     * so a push from a server older than this release still parses; every
     * mobile reader treats absent as 0.
     */
    scheduled: z.number().int().min(0).default(0),
    updatedAt: z.string(),
    expiresAt: z.string(),
    needsInputSince: z.string().nullable(),
    /**
     * Soonest wake among scheduled sessions, or null when none carries one.
     * Optional on input with a null default so a push from a server older than
     * this release still parses.
     */
    scheduledAt: z.string().nullable().default(null),
    // The newest agent state change: its kind in the shared status
    // vocabulary and when it happened. Optional on input with a null default,
    // so a payload from a server that predates the fact still parses while the
    // parsed (output) type stays total — the mobile client spreads the parsed
    // fields straight into a `GlanceableAgentsSnapshot`. Remove the optional
    // and the default when every server sends both keys.
    newestResultKind: z
      .enum(['needsInput', 'running', 'idle', 'scheduled'])
      .nullable()
      .default(null),
    newestResultAt: z.string().nullable().default(null),
    homeWidgetDetails: homeWidgetDetailsSchema.optional(),
  }),
  // One followed session's Android ongoing notification
  // (`.specs/mobile-session-live-activity.md` "Android"). A high-priority
  // data-only message to the device that follows the session; the app
  // renders, updates, or cancels the notification from `content`. Only a
  // device that registered an `android_session_ongoing` row receives it, and
  // `schemaVersion` gates a later shape: a client that does not know the
  // version ignores the message.
  z.object({
    type: z.literal('session_live_update'),
    schemaVersion: z.literal(1),
    event: z.enum(['update', 'end']),
    content: sessionLiveActivityContentStateSchema,
    /**
     * Only on an end: how long a finished notification stays in the shade.
     * 0 removes it at once (the session is gone or out of scope).
     */
    dismissAfterMs: z.number().int().min(0).optional(),
  }),
]);

export type PushData = z.infer<typeof pushDataSchema>;

/**
 * The raw content-state the Active Agents Live Activity renders. The server
 * pushes exactly this shape (counts + status + the safe timestamps: when the
 * counts were confirmed, the needs-input wait and the next wake) and the widget
 * extension renders it directly with baked copy. It must never carry a title,
 * session id, repository name, organization name, generated text, or a raw
 * account id.
 */
export type GlanceableLiveActivityContentState = Pick<
  Extract<PushData, { type: 'active_agents_glanceable' }>,
  | 'status'
  | 'running'
  | 'needsInput'
  | 'needsApproval'
  | 'idle'
  | 'updatedAt'
  | 'needsInputSince'
  | 'scheduled'
  | 'scheduledAt'
>;

/**
 * Relevance per spec "Presentation order": iOS shows the highest score in the
 * Dynamic Island and orders the Lock Screen by it. Both producers use this.
 */
export const LIVE_ACTIVITY_RELEVANCE = {
  sessionNeedsInput: 100,
  aggregateNeedsInput: 80,
  sessionActive: 60,
  aggregate: 40,
  sessionIdle: 20,
} as const;
