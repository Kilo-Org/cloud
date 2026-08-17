/**
 * Shared typed analytics event map and catalog contract (P1-A-07a / DEC-05).
 * See `docs/analytics-event-catalog.md` for the operational contract.
 *
 * One `.strict()` Zod schema per event name, so unknown keys fail and property
 * values stay enum strings, numbers, and booleans. `AnalyticsEventMap` is
 * inferred from the schemas and drives the typed capture helpers in the web and
 * mobile apps and the durable-outbox insert validation (packages/db).
 *
 * New event names are snake_case; `LEGACY_EVENT_NAMES` is the frozen exemption
 * set. Legacy payloads keep their exact current shapes. New terminal outcome
 * events (`*_settled`) carry the DEC-05 base fields.
 */
import { z } from 'zod';

import { ORGANIZATION_ROLES } from '../organizations/roles';

// ----- shared enums -------------------------------------------------------

export const ANALYTICS_SOURCES = ['mobile', 'web', 'server'] as const;
export const ANALYTICS_OUTCOMES = [
  'completed',
  'failed',
  'no_op',
  'interrupted',
  'superseded',
  'ambiguous',
] as const;

/** Legacy mobile surface values (existing payloads, unchanged). */
export const ANALYTICS_SURFACES = ['claw', 'cloud-agent', 'remote-session'] as const;
export const SESSION_OPENED_VIA = ['push', 'app'] as const;
export const INSTANCE_ACTIONS = [
  'destroy',
  'redeploy',
  'start',
  'stop',
  'restart_openclaw',
] as const;
export const PERMISSION_RESPONSES = ['once', 'always', 'reject'] as const;
export const FEEDBACK_SENTIMENTS = ['positive', 'negative'] as const;

/** App cold-start outcome values (mirrors apps/mobile/src/lib/startup-timing.ts). */
export const STARTUP_OUTCOMES = [
  'app',
  'login',
  'consent',
  'force-update',
  'user-error',
  'consent-error',
] as const;

/** KiloClaw onboarding enum values (grandfathered; mirrors onboarding-events.ts). */
export const PROVISION_FAILED_CATEGORIES = ['lock', 'quarantine', 'access', 'generic'] as const;
export const ACCESS_REQUIRED_SUBCASES = [
  'trial_expired',
  'subscription_canceled',
  'subscription_past_due',
  'quarantined',
  'multiple_current_conflict',
  'non_canonical_earlybird',
] as const;

/** Terminal-outcome base fields (DEC-05). */
export const SESSION_CREATE_FAILURE_STAGES = [
  'report',
  'sandbox',
  'ownership_row',
  'registration',
  'initial_admission',
] as const;
export const SESSION_CREATE_ADMISSIONS = ['new', 'takeover'] as const;
export const PR_INTENTS = [
  'merge',
  'submit_review',
  'create_review_comment',
  'reply_comment',
] as const;
export const SECURITY_INTENTS = ['manual_sync', 'dismiss_finding'] as const;
export const ORGANIZATION_INTENTS = ['member_role_change', 'member_remove'] as const;
export const PR_RECONCILE_RESULTS = [
  'confirmed_completed',
  'confirmed_absent',
  'unresolved',
] as const;

// ----- event name constants ------------------------------------------------

// Existing mobile events (grandfathered names, exact current shapes).
export const SESSION_VIEWED_EVENT = 'session_viewed';
export const MESSAGE_SENT_EVENT = 'message_sent';
export const SESSION_CREATED_EVENT = 'session_created';
export const PERMISSION_RESPONDED_EVENT = 'permission_responded';
export const QUESTION_ANSWERED_EVENT = 'question_answered';
export const CONVERSATION_CREATED_EVENT = 'conversation_created';
export const INSTANCE_ACTION_EVENT = 'instance_action';
export const FEEDBACK_SUBMITTED_EVENT = 'feedback_submitted';
export const ORGANIZATION_MEMBER_INVITED_EVENT = 'organization_member_invited';
export const KILO_PASS_PURCHASE_STARTED_EVENT = 'kilo_pass_purchase_started';
export const KILO_PASS_PURCHASE_COMPLETED_EVENT = 'kilo_pass_purchase_completed';
export const KILO_PASS_PURCHASE_FAILED_EVENT = 'kilo_pass_purchase_failed';
export const APP_STARTUP_EVENT = 'app_startup';

// KiloClaw onboarding events. Names are locked to AppsFlyer dashboards; the
// mobile constants live in apps/mobile/src/lib/analytics/onboarding-events.ts.
export const ONBOARDING_ENTERED_EVENT = 'onboarding-entered';
export const PROVISION_REQUESTED_EVENT = 'provision-requested';
export const PROVISION_SUCCEEDED_EVENT = 'provision-succeeded';
export const PROVISION_FAILED_EVENT = 'provision-failed';
export const ACCESS_REQUIRED_SHOWN_EVENT = 'access-required-shown';
export const COMPLETION_REACHED_EVENT = 'completion-reached';
export const CLAW_WEATHER_LOCATION_SELECTED_EVENT = 'claw_weather_location_selected';
export const CLAW_WEATHER_LOCATION_SKIPPED_EVENT = 'claw_weather_location_skipped';

/** AppsFlyer-only mirrored event (raw string at the auth call site). */
export const LOGIN_EVENT = 'login';

// New terminal outcome events (Wave 2 ledger settle path only).
export const SESSION_CREATE_SETTLED_EVENT = 'session_create_settled';
export const PR_OPERATION_SETTLED_EVENT = 'pr_operation_settled';
export const SECURITY_COMMAND_SETTLED_EVENT = 'security_command_settled';
export const ORGANIZATION_WRITE_SETTLED_EVENT = 'organization_write_settled';

/**
 * Grandfathered event names that are exempt from the snake_case rule. Frozen:
 * the snake-case unit test asserts this exact set and forbids additions.
 */
export const LEGACY_EVENT_NAMES: ReadonlySet<string> = new Set([
  ONBOARDING_ENTERED_EVENT,
  PROVISION_REQUESTED_EVENT,
  PROVISION_SUCCEEDED_EVENT,
  PROVISION_FAILED_EVENT,
  ACCESS_REQUIRED_SHOWN_EVENT,
  COMPLETION_REACHED_EVENT,
  CLAW_WEATHER_LOCATION_SELECTED_EVENT,
  CLAW_WEATHER_LOCATION_SKIPPED_EVENT,
]);

/**
 * Terminal outcome events. Only these may be emitted by the durable outbox
 * via the ledger settle path; accepted-phase events are best-effort delivery.
 */
export const TERMINAL_PHASE_EVENTS = [
  SESSION_CREATE_SETTLED_EVENT,
  PR_OPERATION_SETTLED_EVENT,
  SECURITY_COMMAND_SETTLED_EVENT,
  ORGANIZATION_WRITE_SETTLED_EVENT,
] as const;

// ----- schemas -------------------------------------------------------------

/** Every metric field in the catalog is a non-negative integer (count or ms). */
const metric = z.number().int().nonnegative();

/** DEC-05 base fields carried by every terminal outcome event. */
const terminalBase = {
  source: z.enum(ANALYTICS_SOURCES),
  phase: z.literal('terminal'),
  outcome: z.enum(ANALYTICS_OUTCOMES),
} as const;

export const ANALYTICS_EVENT_SCHEMAS = {
  // --- existing mobile events (payloads unchanged) ---
  [SESSION_VIEWED_EVENT]: z
    .object({
      surface: z.enum(ANALYTICS_SURFACES),
      via: z.enum(SESSION_OPENED_VIA),
    })
    .strict(),
  [MESSAGE_SENT_EVENT]: z
    .object({
      surface: z.enum(ANALYTICS_SURFACES),
    })
    .strict(),
  // Accepted-phase metadata, not a terminal outcome (recorded exclusion).
  [SESSION_CREATED_EVENT]: z
    .object({
      surface: z.literal('cloud-agent'),
    })
    .strict(),
  [PERMISSION_RESPONDED_EVENT]: z
    .object({
      surface: z.enum(ANALYTICS_SURFACES),
      response: z.enum(PERMISSION_RESPONSES),
    })
    .strict(),
  [QUESTION_ANSWERED_EVENT]: z
    .object({
      surface: z.enum(ANALYTICS_SURFACES),
      skipped: z.boolean(),
    })
    .strict(),
  [CONVERSATION_CREATED_EVENT]: z
    .object({
      surface: z.literal('claw'),
    })
    .strict(),
  [INSTANCE_ACTION_EVENT]: z
    .object({
      surface: z.literal('claw'),
      action: z.enum(INSTANCE_ACTIONS),
    })
    .strict(),
  [FEEDBACK_SUBMITTED_EVENT]: z
    .object({
      sentiment: z.enum(FEEDBACK_SENTIMENTS),
    })
    .strict(),
  [ORGANIZATION_MEMBER_INVITED_EVENT]: z
    .object({
      role: z.enum(ORGANIZATION_ROLES),
    })
    .strict(),
  [KILO_PASS_PURCHASE_STARTED_EVENT]: z.object({}).strict(),
  [KILO_PASS_PURCHASE_COMPLETED_EVENT]: z.object({}).strict(),
  [KILO_PASS_PURCHASE_FAILED_EVENT]: z.object({}).strict(),
  // Strict at runtime, but the map type stays a record so the mobile
  // `takeStartupTimings()` payload compiles unchanged.
  [APP_STARTUP_EVENT]: z
    .object({
      outcome: z.enum(STARTUP_OUTCOMES),
      auth_ready: metric.optional(),
      fonts_ready: metric.optional(),
      theme_ready: metric.optional(),
      user_ready: metric.optional(),
      consent_ready: metric.optional(),
      splash_hidden: metric.optional(),
    })
    .strict() as z.ZodType<Record<string, string | number>>,

  // --- KiloClaw onboarding events (kebab-case, AppsFlyer-locked) ---
  [ONBOARDING_ENTERED_EVENT]: z.object({}).strict(),
  [PROVISION_REQUESTED_EVENT]: z.object({}).strict(),
  [PROVISION_SUCCEEDED_EVENT]: z.object({}).strict(),
  [PROVISION_FAILED_EVENT]: z
    .object({
      category: z.enum(PROVISION_FAILED_CATEGORIES),
    })
    .strict(),
  [ACCESS_REQUIRED_SHOWN_EVENT]: z
    .object({
      subcase: z.enum(ACCESS_REQUIRED_SUBCASES),
    })
    .strict(),
  [COMPLETION_REACHED_EVENT]: z.object({}).strict(),
  [CLAW_WEATHER_LOCATION_SELECTED_EVENT]: z.object({}).strict(),
  [CLAW_WEATHER_LOCATION_SKIPPED_EVENT]: z.object({}).strict(),

  // AppsFlyer-only mirrored auth event (no properties today).
  [LOGIN_EVENT]: z.object({}).strict(),

  // --- new terminal outcome events (DEC-05 base fields) ---
  [SESSION_CREATE_SETTLED_EVENT]: z
    .object({
      ...terminalBase,
      surface: z.literal('session'),
      creation_target: z.literal('cloud'),
      admission: z.enum(SESSION_CREATE_ADMISSIONS),
      failure_stage: z.enum(SESSION_CREATE_FAILURE_STAGES).optional(),
      duration_ms: metric,
      in_organization: z.boolean(),
    })
    .strict(),
  [PR_OPERATION_SETTLED_EVENT]: z
    .object({
      ...terminalBase,
      surface: z.literal('pr'),
      intent: z.enum(PR_INTENTS),
      reconcile_result: z.enum(PR_RECONCILE_RESULTS).optional(),
      duration_ms: metric,
    })
    .strict(),
  [SECURITY_COMMAND_SETTLED_EVENT]: z
    .object({
      ...terminalBase,
      surface: z.literal('security'),
      intent: z.enum(SECURITY_INTENTS),
      repo_count: metric.optional(),
      error_count: metric.optional(),
      duration_ms: metric,
    })
    .strict(),
  [ORGANIZATION_WRITE_SETTLED_EVENT]: z
    .object({
      ...terminalBase,
      surface: z.literal('organization'),
      intent: z.enum(ORGANIZATION_INTENTS),
    })
    .strict(),
} as const satisfies Record<string, z.ZodType>;

/** Inferred event-name → payload type map. */
export type AnalyticsEventMap = {
  [K in keyof typeof ANALYTICS_EVENT_SCHEMAS]: z.infer<(typeof ANALYTICS_EVENT_SCHEMAS)[K]>;
};

/** Event names that deliver via the durable outbox (terminal outcomes only). */
export type TerminalOutcomeEventName = (typeof TERMINAL_PHASE_EVENTS)[number];

/** Event names that deliver best-effort as accepted-phase metadata. */
export type AcceptedPhaseEventName = Exclude<keyof AnalyticsEventMap, TerminalOutcomeEventName>;
