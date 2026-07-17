import { GATE_THRESHOLDS, REVIEW_STYLES } from '@kilocode/app-shared/code-review';
import * as z from 'zod';

// =============================================================================
// A. Runtime Values (used in enumCheck() or .default())
// =============================================================================

// --- KiloPass enums ---

export enum KiloPassTier {
  Tier19 = 'tier_19',
  Tier49 = 'tier_49',
  Tier199 = 'tier_199',
}

export enum KiloPassCadence {
  Monthly = 'monthly',
  Yearly = 'yearly',
}

export enum KiloPassPaymentProvider {
  Stripe = 'stripe',
  AppStore = 'app_store',
  GooglePlay = 'google_play',
}

export enum KiloPassIssuanceSource {
  StripeInvoice = 'stripe_invoice',
  AppStoreTransaction = 'app_store_transaction',
  GooglePlayTransaction = 'google_play_transaction',
  Cron = 'cron',
}

export enum KiloPassIssuanceItemKind {
  Base = 'base',
  Bonus = 'bonus',
  PromoFirstMonth50Pct = 'promo_first_month_50pct',
  ReferralBonus = 'referral_bonus',
}

export enum KiloPassWelcomePromoPaymentFingerprintType {
  Card = 'card',
  SepaDebit = 'sepa_debit',
  UsBankAccount = 'us_bank_account',
  BacsDebit = 'bacs_debit',
  AuBecsDebit = 'au_becs_debit',
}

export enum KiloPassWelcomePromoEligibilityReason {
  FirstPaymentFingerprintClaim = 'first_payment_fingerprint_claim',
  FingerprintPreviouslyClaimed = 'fingerprint_previously_claimed',
  MissingFingerprint = 'missing_fingerprint',
  NoSupportedFingerprint = 'no_supported_fingerprint',
  NoPositiveSettlement = 'no_positive_settlement',
  SettlementUnresolved = 'settlement_unresolved',
}

export enum KiloPassAuditLogAction {
  StripeWebhookReceived = 'stripe_webhook_received',
  KiloPassInvoicePaidHandled = 'kilo_pass_invoice_paid_handled',
  StorePurchaseCompleted = 'store_purchase_completed',
  StoreNotificationReceived = 'store_notification_received',
  StoreSubscriptionRenewed = 'store_subscription_renewed',
  StoreSubscriptionCanceled = 'store_subscription_canceled',
  StoreSubscriptionExpired = 'store_subscription_expired',
  StoreSubscriptionRefunded = 'store_subscription_refunded',
  BaseCreditsIssued = 'base_credits_issued',
  BonusCreditsIssued = 'bonus_credits_issued',
  BonusCreditsSkippedIdempotent = 'bonus_credits_skipped_idempotent',
  FirstMonth50PctPromoIssued = 'first_month_50pct_promo_issued',
  YearlyMonthlyBaseCronStarted = 'yearly_monthly_base_cron_started',
  YearlyMonthlyBaseCronCompleted = 'yearly_monthly_base_cron_completed',
  IssueYearlyRemainingCredits = 'issue_yearly_remaining_credits',
  DuplicateCardSubscriptionCanceled = 'duplicate_card_subscription_canceled',

  /* Not removed because I didn't want to deal with the migration. */
  /**
   * @deprecated
   */
  YearlyMonthlyBonusCronStarted = 'yearly_monthly_bonus_cron_started',
  /**
   * @deprecated
   */
  YearlyMonthlyBonusCronCompleted = 'yearly_monthly_bonus_cron_completed',
}

export enum KiloPassAuditLogResult {
  Success = 'success',
  SkippedIdempotent = 'skipped_idempotent',
  Failed = 'failed',
}

/** Matches Stripe.SubscriptionSchedule.Status */
export enum KiloPassScheduledChangeStatus {
  NotStarted = 'not_started',
  Active = 'active',
  Completed = 'completed',
  Released = 'released',
  Canceled = 'canceled',
}

// --- Feedback consts ---

export const FeedbackFor = {
  Unknown: 'unknown',
  KiloPass: 'kilopass',
} as const;

export type FeedbackFor = (typeof FeedbackFor)[keyof typeof FeedbackFor];

export const FeedbackSource = {
  Web: 'web',
  Email: 'email',
  Unknown: 'unknown',
} as const;

export type FeedbackSource = (typeof FeedbackSource)[keyof typeof FeedbackSource];

// --- CliSessionSharedState ---

export enum CliSessionSharedState {
  Public = 'public',
  Organization = 'organization',
}

// --- SecurityAuditLogAction ---

/**
 * Actions logged in the security_audit_log table.
 *
 * Follows a consistent 3-segment `security.entity.verb` pattern.
 */
export enum SecurityAuditLogAction {
  FindingCreated = 'security.finding.created',
  FindingSeverityChanged = 'security.finding.severity_changed',
  FindingStatusChange = 'security.finding.status_change',
  FindingDismissed = 'security.finding.dismissed',
  FindingAutoDismissed = 'security.finding.auto_dismissed',
  FindingSuperseded = 'security.finding.superseded',
  FindingAnalysisStarted = 'security.finding.analysis_started',
  FindingAnalysisCompleted = 'security.finding.analysis_completed',
  FindingAnalysisFailed = 'security.finding.analysis_failed',
  RemediationQueued = 'security.remediation.queued',
  RemediationStarted = 'security.remediation.started',
  RemediationPrOpened = 'security.remediation.pr_opened',
  RemediationFailed = 'security.remediation.failed',
  RemediationBlocked = 'security.remediation.blocked',
  RemediationNoChangesNeeded = 'security.remediation.no_changes_needed',
  RemediationCancelled = 'security.remediation.cancelled',
  RemediationRetried = 'security.remediation.retried',
  FindingDeleted = 'security.finding.deleted',
  ConfigEnabled = 'security.config.enabled',
  ConfigDisabled = 'security.config.disabled',
  ConfigUpdated = 'security.config.updated',
  SyncTriggered = 'security.sync.triggered',
  SyncCompleted = 'security.sync.completed',
  AuditLogExported = 'security.audit_log.exported',
  AuditReportGenerated = 'security.audit_report.generated',
}

export enum SecurityFindingAuditSourceContext {
  SecuritySync = 'security_sync',
  Web = 'web',
  AnalysisWorker = 'analysis_worker',
  RemediationCallback = 'remediation_callback',
  RolloutBaseline = 'rollout_baseline',
}

export enum SecurityAuditLogActorType {
  CustomerUser = 'customer_user',
  KiloAdmin = 'kilo_admin',
  System = 'system',
}

// --- KiloClaw enums ---

export const KiloClawPlan = {
  Trial: 'trial',
  Commit: 'commit',
  Standard: 'standard',
} as const;

export type KiloClawPlan = (typeof KiloClawPlan)[keyof typeof KiloClawPlan];

export const KiloClawScheduledPlan = {
  Commit: 'commit',
  Standard: 'standard',
} as const;

export type KiloClawScheduledPlan =
  (typeof KiloClawScheduledPlan)[keyof typeof KiloClawScheduledPlan];

export const KiloClawScheduledBy = {
  Auto: 'auto',
  User: 'user',
} as const;

export type KiloClawScheduledBy = (typeof KiloClawScheduledBy)[keyof typeof KiloClawScheduledBy];

export const KiloClawProvider = {
  Fly: 'fly',
  DockerLocal: 'docker-local',
  Northflank: 'northflank',
} as const;

export type KiloClawProvider = (typeof KiloClawProvider)[keyof typeof KiloClawProvider];

export const KiloClawSubscriptionStatus = {
  Trialing: 'trialing',
  Active: 'active',
  PastDue: 'past_due',
  Canceled: 'canceled',
  Unpaid: 'unpaid',
} as const;

export type KiloClawSubscriptionStatus =
  (typeof KiloClawSubscriptionStatus)[keyof typeof KiloClawSubscriptionStatus];

export const KiloClawPaymentSource = {
  Stripe: 'stripe',
  Credits: 'credits',
} as const;

export type KiloClawPaymentSource =
  (typeof KiloClawPaymentSource)[keyof typeof KiloClawPaymentSource];

export const KiloClawSubscriptionAccessOrigin = {
  Earlybird: 'earlybird',
} as const;

export type KiloClawSubscriptionAccessOrigin =
  (typeof KiloClawSubscriptionAccessOrigin)[keyof typeof KiloClawSubscriptionAccessOrigin];

export const KiloClawSubscriptionChangeActorType = {
  User: 'user',
  System: 'system',
} as const;

export type KiloClawSubscriptionChangeActorType =
  (typeof KiloClawSubscriptionChangeActorType)[keyof typeof KiloClawSubscriptionChangeActorType];

export const KiloClawTerminalRenewalFailureStatus = {
  Unresolved: 'unresolved',
  Resolved: 'resolved',
  Waived: 'waived',
  Superseded: 'superseded',
} as const;

export type KiloClawTerminalRenewalFailureStatus =
  (typeof KiloClawTerminalRenewalFailureStatus)[keyof typeof KiloClawTerminalRenewalFailureStatus];

// System failure codes for credit-renewal terminal failures. These are
// recorded only after automatic retry is exhausted for a particular
// (subscription, renewal_boundary). Expected business outcomes
// (e.g. insufficient credits past-due, cancel-at-period-end, stale skip)
// MUST NOT be recorded as terminal failures and so are not part of this set.
export const KiloClawTerminalRenewalFailureCode = {
  CreditBalanceReadFailed: 'credit_balance_read_failed',
  RenewalTransactionFailed: 'renewal_transaction_failed',
  AutoTopUpMarkerWriteFailed: 'auto_top_up_marker_write_failed',
  WorkerTimeout: 'worker_timeout',
  PoisonPayload: 'poison_payload',
  QueueDeliveryExhausted: 'queue_delivery_exhausted',
} as const;

export type KiloClawTerminalRenewalFailureCode =
  (typeof KiloClawTerminalRenewalFailureCode)[keyof typeof KiloClawTerminalRenewalFailureCode];

export const KiloClawTerminalRenewalFailureResolutionActorType = {
  Operator: 'operator',
  System: 'system',
} as const;

export type KiloClawTerminalRenewalFailureResolutionActorType =
  (typeof KiloClawTerminalRenewalFailureResolutionActorType)[keyof typeof KiloClawTerminalRenewalFailureResolutionActorType];

export const KiloClawSubscriptionChangeAction = {
  Created: 'created',
  StatusChanged: 'status_changed',
  PlanSwitched: 'plan_switched',
  PeriodAdvanced: 'period_advanced',
  Canceled: 'canceled',
  Reactivated: 'reactivated',
  Suspended: 'suspended',
  DestructionScheduled: 'destruction_scheduled',
  Reassigned: 'reassigned',
  Backfilled: 'backfilled',
  PaymentSourceChanged: 'payment_source_changed',
  ScheduleChanged: 'schedule_changed',
  AdminOverride: 'admin_override',
} as const;

export type KiloClawSubscriptionChangeAction =
  (typeof KiloClawSubscriptionChangeAction)[keyof typeof KiloClawSubscriptionChangeAction];

export const StripeEarlyFraudWarningOwnerClassification = {
  Personal: 'personal',
  Organization: 'organization',
  Ambiguous: 'ambiguous',
  Unmatched: 'unmatched',
} as const;

export type StripeEarlyFraudWarningOwnerClassification =
  (typeof StripeEarlyFraudWarningOwnerClassification)[keyof typeof StripeEarlyFraudWarningOwnerClassification];

export const StripeEarlyFraudWarningCaseStatus = {
  Queued: 'queued',
  Contained: 'contained',
  Processing: 'processing',
  Completed: 'completed',
  ReviewRequired: 'review_required',
  Failed: 'failed',
  Remediated: 'remediated',
  Dismissed: 'dismissed',
} as const;

export type StripeEarlyFraudWarningCaseStatus =
  (typeof StripeEarlyFraudWarningCaseStatus)[keyof typeof StripeEarlyFraudWarningCaseStatus];

export const StripeEarlyFraudWarningActionType = {
  Containment: 'containment',
  Refund: 'refund',
  PaymentValueClawback: 'payment_value_clawback',
  SubscriptionTermination: 'subscription_termination',
  AccessTermination: 'access_termination',
  KiloClawSuspension: 'kiloclaw_suspension',
  AffiliatePayoutReversal: 'affiliate_payout_reversal',
  ReferralRewardReversal: 'referral_reward_reversal',
  UserNotice: 'user_notice',
} as const;

export type StripeEarlyFraudWarningActionType =
  (typeof StripeEarlyFraudWarningActionType)[keyof typeof StripeEarlyFraudWarningActionType];

export const StripeEarlyFraudWarningActionStatus = {
  Queued: 'queued',
  Processing: 'processing',
  Completed: 'completed',
  Failed: 'failed',
  ReviewRequired: 'review_required',
  Dismissed: 'dismissed',
} as const;

export type StripeEarlyFraudWarningActionStatus =
  (typeof StripeEarlyFraudWarningActionStatus)[keyof typeof StripeEarlyFraudWarningActionStatus];

export const StripeDisputeOwnerClassification = {
  Personal: 'personal',
  Organization: 'organization',
  Ambiguous: 'ambiguous',
  Unmatched: 'unmatched',
} as const;

export type StripeDisputeOwnerClassification =
  (typeof StripeDisputeOwnerClassification)[keyof typeof StripeDisputeOwnerClassification];

export const StripeDisputeCaseStatus = {
  NeedsAction: 'needs_action',
  Processing: 'processing',
  Accepted: 'accepted',
  AcceptanceFailed: 'acceptance_failed',
  EnforcementFailed: 'enforcement_failed',
  ReviewRequired: 'review_required',
  Closed: 'closed',
} as const;

export type StripeDisputeCaseStatus =
  (typeof StripeDisputeCaseStatus)[keyof typeof StripeDisputeCaseStatus];

export const StripeDisputeActionType = {
  StripeAcceptance: 'stripe_acceptance',
  UserBlock: 'user_block',
  AutoTopUpDisable: 'auto_top_up_disable',
  CreditBalanceReset: 'credit_balance_reset',
  SubscriptionCancellation: 'subscription_cancellation',
  AccessTermination: 'access_termination',
  KiloClawSuspension: 'kiloclaw_suspension',
} as const;

export type StripeDisputeActionType =
  (typeof StripeDisputeActionType)[keyof typeof StripeDisputeActionType];

export const StripeDisputeActionStatus = {
  Queued: 'queued',
  Processing: 'processing',
  Completed: 'completed',
  Failed: 'failed',
  Skipped: 'skipped',
} as const;

export type StripeDisputeActionStatus =
  (typeof StripeDisputeActionStatus)[keyof typeof StripeDisputeActionStatus];

export const AffiliateProvider = {
  Impact: 'impact',
} as const;

export type AffiliateProvider = (typeof AffiliateProvider)[keyof typeof AffiliateProvider];

export const AffiliateEventType = {
  Signup: 'signup',
  TrialStart: 'trial_start',
  TrialEnd: 'trial_end',
  Sale: 'sale',
  SaleReversal: 'sale_reversal',
} as const;

export type AffiliateEventType = (typeof AffiliateEventType)[keyof typeof AffiliateEventType];

export const AffiliateEventDeliveryState = {
  Queued: 'queued',
  Blocked: 'blocked',
  Sending: 'sending',
  Delivered: 'delivered',
  Failed: 'failed',
} as const;

export type AffiliateEventDeliveryState =
  (typeof AffiliateEventDeliveryState)[keyof typeof AffiliateEventDeliveryState];

export const ImpactReferralProduct = {
  KiloClaw: 'kiloclaw',
  KiloPass: 'kilo_pass',
} as const;

export type ImpactReferralProduct =
  (typeof ImpactReferralProduct)[keyof typeof ImpactReferralProduct];

export const ImpactAdvocateProgramKey = {
  KiloClaw: 'kiloclaw',
  KiloPass: 'kilo_pass',
} as const;

export type ImpactAdvocateProgramKey =
  (typeof ImpactAdvocateProgramKey)[keyof typeof ImpactAdvocateProgramKey];

export const ImpactAttributionTouchType = {
  Affiliate: 'affiliate',
  Referral: 'referral',
} as const;

export type ImpactAttributionTouchType =
  (typeof ImpactAttributionTouchType)[keyof typeof ImpactAttributionTouchType];

export const ImpactAttributionTouchProvider = {
  ImpactPerformance: 'impact_performance',
  ImpactAdvocate: 'impact_advocate',
} as const;

export type ImpactAttributionTouchProvider =
  (typeof ImpactAttributionTouchProvider)[keyof typeof ImpactAttributionTouchProvider];

export const ImpactAdvocateRegistrationState = {
  Pending: 'pending',
  Retrying: 'retrying',
  Registered: 'registered',
  Failed: 'failed',
} as const;

export type ImpactAdvocateRegistrationState =
  (typeof ImpactAdvocateRegistrationState)[keyof typeof ImpactAdvocateRegistrationState];

export const ImpactAdvocateAttemptDeliveryState = {
  Queued: 'queued',
  Sending: 'sending',
  Succeeded: 'succeeded',
  Failed: 'failed',
} as const;

export type ImpactAdvocateAttemptDeliveryState =
  (typeof ImpactAdvocateAttemptDeliveryState)[keyof typeof ImpactAdvocateAttemptDeliveryState];

export const ImpactReferralBeneficiaryRole = {
  Referrer: 'referrer',
  Referee: 'referee',
} as const;

export type ImpactReferralBeneficiaryRole =
  (typeof ImpactReferralBeneficiaryRole)[keyof typeof ImpactReferralBeneficiaryRole];

export const ImpactReferralWinningTouchType = {
  Referral: 'referral',
  Affiliate: 'affiliate',
  None: 'none',
} as const;

export type ImpactReferralWinningTouchType =
  (typeof ImpactReferralWinningTouchType)[keyof typeof ImpactReferralWinningTouchType];

export const ImpactReferralDecisionOutcome = {
  Granted: 'granted',
  CapLimited: 'cap_limited',
  Disqualified: 'disqualified',
} as const;

export type ImpactReferralDecisionOutcome =
  (typeof ImpactReferralDecisionOutcome)[keyof typeof ImpactReferralDecisionOutcome];

export const ImpactReferralRewardStatus = {
  Pending: 'pending',
  Earned: 'earned',
  Applied: 'applied',
  Reversed: 'reversed',
  Expired: 'expired',
  Canceled: 'canceled',
  ReviewRequired: 'review_required',
} as const;

export type ImpactReferralRewardStatus =
  (typeof ImpactReferralRewardStatus)[keyof typeof ImpactReferralRewardStatus];

export const ImpactReferralRewardKind = {
  KiloClawFreeMonth: 'kiloclaw_free_month',
  KiloPassBonus: 'kilo_pass_bonus',
} as const;

export type ImpactReferralRewardKind =
  (typeof ImpactReferralRewardKind)[keyof typeof ImpactReferralRewardKind];

export const ImpactReferralPaymentProvider = {
  Stripe: 'stripe',
  Credits: 'credits',
  AppStore: 'app_store',
  GooglePlay: 'google_play',
} as const;

export type ImpactReferralPaymentProvider =
  (typeof ImpactReferralPaymentProvider)[keyof typeof ImpactReferralPaymentProvider];

export const KiloClawReferralBeneficiaryRole = ImpactReferralBeneficiaryRole;
export type KiloClawReferralBeneficiaryRole = ImpactReferralBeneficiaryRole;

export const KiloClawReferralWinningTouchType = ImpactReferralWinningTouchType;
export type KiloClawReferralWinningTouchType = ImpactReferralWinningTouchType;

export const KiloClawReferralDecisionOutcome = ImpactReferralDecisionOutcome;
export type KiloClawReferralDecisionOutcome = ImpactReferralDecisionOutcome;

export const KiloClawReferralRewardStatus = ImpactReferralRewardStatus;
export type KiloClawReferralRewardStatus = ImpactReferralRewardStatus;

export const ImpactConversionReportState = {
  Queued: 'queued',
  Retrying: 'retrying',
  Delivered: 'delivered',
  Failed: 'failed',
} as const;

export type ImpactConversionReportState =
  (typeof ImpactConversionReportState)[keyof typeof ImpactConversionReportState];

export const ImpactAdvocateRewardRedemptionState = {
  Queued: 'queued',
  Retrying: 'retrying',
  Redeemed: 'redeemed',
  Failed: 'failed',
} as const;

export type ImpactAdvocateRewardRedemptionState =
  (typeof ImpactAdvocateRewardRedemptionState)[keyof typeof ImpactAdvocateRewardRedemptionState];

// --- Coding Plan enums ---

export const BYOKManagementSource = {
  User: 'user',
  CodingPlan: 'coding_plan',
} as const;

export type BYOKManagementSource = (typeof BYOKManagementSource)[keyof typeof BYOKManagementSource];

export const CodingPlanCredentialStatus = {
  Available: 'available',
  Assigned: 'assigned',
  RevocationPending: 'revocation_pending',
  Revoked: 'revoked',
  RevocationFailed: 'revocation_failed',
} as const;

export type CodingPlanCredentialStatus =
  (typeof CodingPlanCredentialStatus)[keyof typeof CodingPlanCredentialStatus];

export const CodingPlanSubscriptionStatus = {
  Active: 'active',
  PastDue: 'past_due',
  Canceled: 'canceled',
} as const;

export type CodingPlanSubscriptionStatus =
  (typeof CodingPlanSubscriptionStatus)[keyof typeof CodingPlanSubscriptionStatus];

export const CodingPlanTermKind = {
  Activation: 'activation',
  Extension: 'extension',
  Renewal: 'renewal',
} as const;

export type CodingPlanTermKind = (typeof CodingPlanTermKind)[keyof typeof CodingPlanTermKind];

// --- Cost Insights enums ---

export const CostInsightSpendCategory = {
  Variable: 'variable',
  Scheduled: 'scheduled',
} as const;

export type CostInsightSpendCategory =
  (typeof CostInsightSpendCategory)[keyof typeof CostInsightSpendCategory];

export const CostInsightSpendSource = {
  AiGateway: 'ai_gateway',
  KiloClaw: 'kiloclaw',
  CodingPlan: 'coding_plan',
  Other: 'other',
} as const;

export type CostInsightSpendSource =
  (typeof CostInsightSpendSource)[keyof typeof CostInsightSpendSource];

export const CostInsightRollupDegradedReason = {
  CaptureBypass: 'capture_bypass',
  ReconciliationMismatch: 'reconciliation_mismatch',
  LateSourceData: 'late_source_data',
} as const;

export type CostInsightRollupDegradedReason =
  (typeof CostInsightRollupDegradedReason)[keyof typeof CostInsightRollupDegradedReason];

export const CostInsightEventType = {
  ConfigChanged: 'config_changed',
  AnomalyAlert: 'anomaly_alert',
  ThresholdCrossed: 'threshold_crossed',
  AlertReviewed: 'alert_reviewed',
  SuggestionCreated: 'suggestion_created',
  SuggestionDismissed: 'suggestion_dismissed',
  Disabled: 'disabled',
} as const;

export type CostInsightEventType = (typeof CostInsightEventType)[keyof typeof CostInsightEventType];

export const CostInsightAlertKind = {
  Anomaly: 'anomaly',
  Threshold: 'threshold',
  Threshold7Day: 'threshold_7d',
  Threshold30Day: 'threshold_30d',
} as const;

export type CostInsightAlertKind = (typeof CostInsightAlertKind)[keyof typeof CostInsightAlertKind];

export const CostInsightSuggestionKind = {
  CodingPlan: 'coding_plan',
  KiloPass: 'kilo_pass',
} as const;

export type CostInsightSuggestionKind =
  (typeof CostInsightSuggestionKind)[keyof typeof CostInsightSuggestionKind];

export const CostInsightNotificationStatus = {
  Pending: 'pending',
  Sending: 'sending',
  Sent: 'sent',
  Failed: 'failed',
  Skipped: 'skipped',
} as const;

export type CostInsightNotificationStatus =
  (typeof CostInsightNotificationStatus)[keyof typeof CostInsightNotificationStatus];

// NOTE: Do not change these action names. Use present tense for consistency.
export const KiloClawAdminAuditAction = z.enum([
  'kiloclaw.volume.extend',
  'kiloclaw.volume.reassociate',
  'kiloclaw.snapshot.restore',
  'kiloclaw.recovery.cleanup_retained_volume',
  'kiloclaw.subscription.update_trial_end',
  'kiloclaw.subscription.reset_trial',
  'kiloclaw.machine.start',
  'kiloclaw.machine.stop',
  'kiloclaw.instance.destroy',
  'kiloclaw.gateway.start',
  'kiloclaw.gateway.stop',
  'kiloclaw.gateway.restart',
  'kiloclaw.config.restore',
  'kiloclaw.doctor.run',
  'kiloclaw.inbound_email.cycle',
  'kiloclaw.inbound_email.update_enabled',
  'kiloclaw.machine.destroy_fly',
  'kiloclaw.machine.resize',
  'kiloclaw.admin_size_override.set',
  'kiloclaw.admin_size_override.clear',
  'kiloclaw.subscription.bulk_trial_grant',
  'kiloclaw.subscription.admin_cancel',
  'kiloclaw.cli_run.start',
  'kiloclaw.cli_run.cancel',
  'kiloclaw.orphan.destroy',
  'kiloclaw.orphan_volume.destroy',
  'kiloclaw.instances.bulk_change_version',
  'kiloclaw.scheduled_action.created',
  'kiloclaw.fleet_upgrade.created',
  'kiloclaw.scheduled_action.cancelled',
  'kiloclaw.provision_reservation.release',
]);

export type KiloClawAdminAuditAction = z.infer<typeof KiloClawAdminAuditAction>;

// --- KiloClaw scheduled action status enums ---

// Parent action status. Lifecycle:
//   scheduled → running → completed (or failed if every target failed)
//   scheduled or running → cancelled (by admin)
export const KiloClawScheduledActionStatus = z.enum([
  'scheduled',
  'running',
  'completed',
  'cancelled',
  'failed',
]);
export type KiloClawScheduledActionStatus = z.infer<typeof KiloClawScheduledActionStatus>;

// Stage status. Same lifecycle as the parent action.
export const KiloClawScheduledActionStageStatus = z.enum([
  'pending',
  'running',
  'completed',
  'cancelled',
  'failed',
]);
export type KiloClawScheduledActionStageStatus = z.infer<typeof KiloClawScheduledActionStageStatus>;

// Target status. 'running' is a transient claim state set by the DO
// apply path immediately before it dispatches the side effect; final
// states are 'applied', 'skipped', or 'failed'.
export const KiloClawScheduledActionTargetStatus = z.enum([
  'pending',
  'running',
  'applied',
  'skipped',
  'failed',
]);
export type KiloClawScheduledActionTargetStatus = z.infer<
  typeof KiloClawScheduledActionTargetStatus
>;

// Notification dispatch lifecycle. 'pending' until the sweep claims
// it via the CAS pending → sending; 'sending' is a transient state
// while the sweep is mid-dispatch (set when claimed, cleared by markSent
// or markFailed); 'sent' on successful dispatch; 'failed' if the channel
// returned an error. Recovery: stuck 'sending' rows whose claimed_at is
// older than the recovery threshold get reset to 'pending' at the top
// of each tick.
export const KiloClawScheduledActionNotificationStatus = z.enum([
  'pending',
  'sending',
  'sent',
  'failed',
]);
export type KiloClawScheduledActionNotificationStatus = z.infer<
  typeof KiloClawScheduledActionNotificationStatus
>;

// Notification dispatch channel. 'agent' is reserved for a future PR
// that adds a kilo-chat sendSystemNotice RPC; the v1 dispatcher returns
// 501 for that channel so the schema enum can stabilize without the
// dispatcher implementation.
export const KiloClawScheduledActionNotificationChannel = z.enum([
  'email',
  'webapp',
  'mobile_push',
  'agent',
]);
export type KiloClawScheduledActionNotificationChannel = z.infer<
  typeof KiloClawScheduledActionNotificationChannel
>;

// Why this notification exists. 'notice' is the upcoming-action heads-up
// dispatched ahead of the scheduled time. 'cancelled' is the follow-up
// when an admin cancels an action whose notice has already been sent
// for the same (target, channel) pair.
export const KiloClawScheduledActionNotificationKind = z.enum(['notice', 'cancelled']);
export type KiloClawScheduledActionNotificationKind = z.infer<
  typeof KiloClawScheduledActionNotificationKind
>;

// --- ContributorChampion enums ---

export const ContributorChampionTier = {
  Contributor: 'contributor',
  Ambassador: 'ambassador',
  Champion: 'champion',
} as const;

export type ContributorChampionTier =
  (typeof ContributorChampionTier)[keyof typeof ContributorChampionTier];

// =============================================================================
// B. Type-Only Definitions (used in $type<T>())
// =============================================================================

// --- Organization types ---

export type OrganizationRole = 'owner' | 'member' | 'billing_manager';

export const OrganizationPlanSchema = z.enum(['teams', 'enterprise']);

export type OrganizationPlan = z.infer<typeof OrganizationPlanSchema>;

export const ORGANIZATION_AUTO_MODEL_ID = 'kilo-auto/org';
export const MAX_ORGANIZATION_AUTO_ROUTES = 100;

const OrganizationAutoModelRouteSlugSchema = z
  .string()
  .min(1, 'Organization Auto route slug is required')
  .max(50, 'Organization Auto route slug must be less than 50 characters')
  .regex(
    /^[a-z0-9-]+$/,
    'Organization Auto route slug must contain only lowercase letters, numbers, and hyphens'
  );

const OrganizationAutoModelTargetSchema = z
  .string()
  .min(1, 'Organization Auto route target is required')
  .max(200, 'Organization Auto route target must be less than 200 characters')
  .refine(value => !value.endsWith('/*'), {
    message: 'Organization Auto route target must be a concrete model identifier',
  })
  .refine(value => value !== ORGANIZATION_AUTO_MODEL_ID, {
    message: 'Organization Auto cannot target itself',
  });

export const OrganizationAutoModelSettingsSchema = z.object({
  routes: z
    .record(OrganizationAutoModelRouteSlugSchema, OrganizationAutoModelTargetSchema)
    .refine(routes => Object.keys(routes).length <= MAX_ORGANIZATION_AUTO_ROUTES, {
      message: `Organization Auto supports at most ${MAX_ORGANIZATION_AUTO_ROUTES} routes`,
    }),
  fallback_model: OrganizationAutoModelTargetSchema,
});

export type OrganizationAutoModelSettings = z.infer<typeof OrganizationAutoModelSettingsSchema>;

const OrganizationSettingsSchema = z.object({
  provider_allow_list: z.array(z.string()).optional(),

  model_deny_list: z.array(z.string()).optional(),

  default_model: z.string().optional(),
  org_auto_model: OrganizationAutoModelSettingsSchema.optional(),
  data_collection: z.enum(['allow', 'deny']).nullable().optional(),
  // null means they were grandfathered in and so they have usage limits enabled
  enable_usage_limits: z.boolean().optional(),
  code_indexing_enabled: z.boolean().optional(),
  projects_ui_enabled: z.boolean().optional(),
  minimum_balance: z.number().optional(),
  minimum_balance_alert_email: z.array(z.email()).optional(),
  // Whether the weekly enterprise recommendations digest email is enabled. When on,
  // the digest is emailed to the organization's owners. Enterprise-only feature.
  // Named "recommendations" (not "adoption") to avoid confusion with AI adoption
  // usage data and the Feature adoption tab.
  recommendations_digest_enabled: z.boolean().optional(),
  suppress_trial_messaging: z.boolean().optional(),
  // OSS Sponsorship fields
  // null/undefined = not an OSS org, values: 1, 2, or 3
  oss_sponsorship_tier: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .nullable()
    .optional(),
  github_app_type: z.enum(['lite', 'standard']).nullable().optional(),
  // Credits to reset to every 30 days (in microdollars)
  oss_monthly_credit_amount_microdollars: z.number().nullable().optional(),
  // When credits were last reset (ISO timestamp string)
  oss_credits_last_reset_at: z.string().nullable().optional(),
  // Full GitHub URL for OSS sponsored repos (e.g., https://github.com/org/repo)
  oss_github_url: z.string().url().nullable().optional(),
});

export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;

const GroupNameSchema = z.enum(['read', 'edit', 'browser', 'command', 'mcp']);

const EditGroupConfigSchema = z.object({
  fileRegex: z.string().min(1, 'File regex cannot be empty'),
  description: z.string().optional(),
});

// Groups can be either simple strings or tuples for edit with config
const GroupEntrySchema = z.union([
  GroupNameSchema,
  z.tuple([z.literal('edit'), EditGroupConfigSchema]),
]);

export const OrganizationModeConfigSchema = z.object({
  roleDefinition: z.string().min(1, 'Role definition is required'),
  whenToUse: z.string().optional(),
  description: z.string().optional(),
  customInstructions: z.string().optional(),
  groups: z.array(GroupEntrySchema),
});

export type OrganizationModeConfig = z.infer<typeof OrganizationModeConfigSchema>;
export type EditGroupConfig = z.infer<typeof EditGroupConfigSchema>;

// ============================================================================
// Agent (modern replacement for legacy `customModes`)
// ============================================================================
//
// Mirrors the kilocode CLI's `AgentConfig` shape — see
// `packages/opencode/src/config/agent.ts` and
// `packages/opencode/src/config/permission.ts` in the kilocode repo. The
// stored config is passed through to `KILO_CONFIG_CONTENT.agent.<slug>`
// almost verbatim; no runtime migration is needed.

/** Permission action — `null` is the CLI's "delete" sentinel. */
const PermissionActionSchema = z.enum(['allow', 'ask', 'deny']);
const PermissionActionOrNullSchema = z.union([PermissionActionSchema, z.null()]);

/**
 * Permission rule: either a single action, or a per-pattern map of glob →
 * action. Used for tools like `read`, `edit`, `bash` that accept per-path
 * restrictions.
 */
const PermissionRuleSchema = z.union([
  PermissionActionOrNullSchema,
  z.record(z.string(), PermissionActionOrNullSchema),
]);

/**
 * Permission config. Either a bare action (shorthand for "all tools at this
 * level") or a per-tool map. Accepts unknown tool keys so new CLI tools
 * don't immediately fail validation.
 */
export const PermissionConfigSchema = z.union([
  PermissionActionSchema,
  z
    .object({
      read: PermissionRuleSchema.optional(),
      edit: PermissionRuleSchema.optional(),
      glob: PermissionRuleSchema.optional(),
      grep: PermissionRuleSchema.optional(),
      list: PermissionRuleSchema.optional(),
      bash: PermissionRuleSchema.optional(),
      task: PermissionRuleSchema.optional(),
      external_directory: PermissionRuleSchema.optional(),
      // Action-only (no per-pattern sub-targets) — matches CLI shape.
      todowrite: PermissionActionOrNullSchema.optional(),
      question: PermissionActionOrNullSchema.optional(),
      webfetch: PermissionActionOrNullSchema.optional(),
      websearch: PermissionActionOrNullSchema.optional(),
      codesearch: PermissionActionOrNullSchema.optional(),
      doom_loop: PermissionActionOrNullSchema.optional(),
      lsp: PermissionRuleSchema.optional(),
      skill: PermissionRuleSchema.optional(),
      agent_manager: PermissionRuleSchema.optional(),
    })
    .catchall(PermissionRuleSchema),
]);

export type PermissionAction = z.infer<typeof PermissionActionSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;

const AgentVisibilitySchema = z.enum(['subagent', 'primary', 'all']);

/** Hex `#RRGGBB` or one of the CLI's theme literals. */
const AgentColorSchema = z.union([
  z.string().regex(/^#[0-9a-fA-F]{6}$/),
  z.enum(['primary', 'secondary', 'accent', 'success', 'warning', 'error', 'info']),
]);

/**
 * Authoritative validator for a profile-scoped Agent's `config` jsonb column.
 * All fields optional — the CLI pulls defaults from the model and profile
 * layers. An empty `{}` is a valid agent.
 */
export const AgentConfigSchema = z
  .object({
    prompt: z.string().max(50_000).optional(),
    description: z.string().max(2_000).optional(),
    mode: AgentVisibilitySchema.optional(),
    model: z.string().max(200).nullable().optional(),
    variant: z.string().max(50).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    steps: z.number().int().positive().optional(),
    hidden: z.boolean().optional(),
    disable: z.boolean().optional(),
    color: AgentColorSchema.optional(),
    permission: PermissionConfigSchema.optional(),
    /** Freeform bag — CLI rolls unknown top-level keys into here. */
    options: z.record(z.string(), z.unknown()).optional(),
  })
  // Variant keys are model-specific (each model defines its own
  // `opencode.variants` map), so a `variant` without a `model` has no
  // anchor — reject it instead of silently dropping it at runtime.
  .refine(c => !c.variant || (typeof c.model === 'string' && c.model.length > 0), {
    message: 'variant requires a model — variants are model-specific',
    path: ['variant'],
  });

export type AgentVisibility = z.infer<typeof AgentVisibilitySchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export { OrganizationSettingsSchema };

// --- AuditLogAction ---

export type AuditLogAction = z.infer<typeof AuditLogAction>;

// NOTE: (bmc) - do not change these action names.
// if you introduce a new event action, please use present tense for consistency.
export const AuditLogAction = z.enum([
  'organization.user.login', // ✅
  'organization.user.logout', // TODO: (bmc) - not sure nextauth lets us get this?
  'organization.user.accept_invite', // ✅
  'organization.user.send_invite', // ✅
  'organization.user.revoke_invite', // ✅
  'organization.settings.change', // ✅
  'organization.settings.auto_change', // ✅ (system-initiated; null actor)
  'organization.purchase_credits', // ✅
  'organization.promo_credit_granted', // ✅
  'organization.member.remove', // ✅
  'organization.member.change_role', // ✅
  'organization.member.admin_add',
  'organization.sso.auto_provision', // ✅
  'organization.sso.set_domain', // ✅
  'organization.sso.remove_domain', // ✅
  'organization.mode.create', // ✅
  'organization.mode.update', // ✅
  'organization.mode.delete', // ✅
  'organization.created', // ✅
  'organization.token.generate', // ✅
  'organization.funds.distribute_to_children', // ✅
]);

// --- EncryptedData ---

export type EncryptedData = {
  iv: string;
  data: string;
  authTag: string;
};

// --- AuthProviderId ---

export type AuthProviderId =
  | 'apple'
  | 'email'
  | 'google'
  | 'github'
  | 'gitlab'
  | 'linkedin'
  | 'discord'
  | 'fake-login'
  | 'workos';

// --- AbuseClassification ---

export type AbuseClassification = (typeof ABUSE_CLASSIFICATION)[keyof typeof ABUSE_CLASSIFICATION];
export const ABUSE_CLASSIFICATION = {
  NOT_ABUSE: -100,
  CLASSIFICATION_ERROR: -50,
  NOT_CLASSIFIED: 0,
  LIKELY_ABUSE: 200,
} as const;

// --- Microdollar Usage --

export const GatewayApiKindSchema = z.enum([
  'chat_completions',
  'embeddings',
  'fim_completions',
  'edit_completions',
  'messages',
  'responses',
  'audio_transcriptions',
]);

export type GatewayApiKind = z.infer<typeof GatewayApiKindSchema>;

// --- Integration types ---

export type IntegrationPermissions = Record<string, string>;

export type PlatformRepository<TId extends number | string = number> = {
  id: TId;
  name: string;
  full_name: string;
  private: boolean;
  default_branch?: string;
};

export const REVIEW_MEMORY_PLATFORMS = ['github'] as const;
export type ReviewMemoryPlatform = (typeof REVIEW_MEMORY_PLATFORMS)[number];

export const REVIEW_MEMORY_PROPOSAL_STATUSES = [
  'open',
  'edited',
  'rejected',
  'opening_change_request',
  'change_request_opened',
  'change_request_failed',
  'superseded',
] as const;
export type ReviewMemoryProposalStatus = (typeof REVIEW_MEMORY_PROPOSAL_STATUSES)[number];

export type ReviewMemoryEvidenceItem = { excerpt: string; prNumber: number | null };

// --- Deployment types ---

export const providerSchema = z.enum(['github', 'git', 'app-builder']);

export type Provider = z.infer<typeof providerSchema>;

export const buildStatusSchema = z.enum([
  'queued',
  'building',
  'deploying',
  'deployed',
  'failed',
  'cancelled',
]);

export type BuildStatus = z.infer<typeof buildStatusSchema>;

// --- Code Reviewer analytics ---

export const CODE_REVIEW_ANALYTICS_SCHEMA_VERSION = 1;
export const CODE_REVIEW_ANALYTICS_TAXONOMY_VERSION = 1;

export const CodeReviewAnalyticsCaptureStatus = {
  Captured: 'captured',
  Missing: 'missing',
  Invalid: 'invalid',
  Omitted: 'omitted',
} as const;

export type CodeReviewAnalyticsCaptureStatus =
  (typeof CodeReviewAnalyticsCaptureStatus)[keyof typeof CodeReviewAnalyticsCaptureStatus];

export const CodeReviewAnalyticsChangeType = {
  BugFix: 'bug_fix',
  Feature: 'feature',
  Refactor: 'refactor',
  Maintenance: 'maintenance',
  Dependency: 'dependency',
  Test: 'test',
  Documentation: 'documentation',
  Mixed: 'mixed',
  Other: 'other',
} as const;

export type CodeReviewAnalyticsChangeType =
  (typeof CodeReviewAnalyticsChangeType)[keyof typeof CodeReviewAnalyticsChangeType];

export const CodeReviewAnalyticsImpactLevel = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
} as const;

export type CodeReviewAnalyticsImpactLevel =
  (typeof CodeReviewAnalyticsImpactLevel)[keyof typeof CodeReviewAnalyticsImpactLevel];

export const CodeReviewAnalyticsComplexityLevel = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
} as const;

export type CodeReviewAnalyticsComplexityLevel =
  (typeof CodeReviewAnalyticsComplexityLevel)[keyof typeof CodeReviewAnalyticsComplexityLevel];

export const CodeReviewAnalyticsClassificationConfidence = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
} as const;

export type CodeReviewAnalyticsClassificationConfidence =
  (typeof CodeReviewAnalyticsClassificationConfidence)[keyof typeof CodeReviewAnalyticsClassificationConfidence];

export const CodeReviewFindingSeverity = {
  Critical: 'critical',
  Warning: 'warning',
  Suggestion: 'suggestion',
} as const;

export type CodeReviewFindingSeverity =
  (typeof CodeReviewFindingSeverity)[keyof typeof CodeReviewFindingSeverity];

export const CodeReviewFindingCategory = {
  Security: 'security',
  Correctness: 'correctness',
  Reliability: 'reliability',
  DataIntegrity: 'data_integrity',
  Performance: 'performance',
  Compatibility: 'compatibility',
  Maintainability: 'maintainability',
  TestQuality: 'test_quality',
  Documentation: 'documentation',
  Accessibility: 'accessibility',
  Other: 'other',
} as const;

export type CodeReviewFindingCategory =
  (typeof CodeReviewFindingCategory)[keyof typeof CodeReviewFindingCategory];

export const CodeReviewFindingSecurityClass = {
  AuthAccess: 'auth_access',
  Injection: 'injection',
  DataProtection: 'data_protection',
  RequestResourceBoundary: 'request_resource_boundary',
  DeserializationObjectIntegrity: 'deserialization_object_integrity',
  DependencySupplyChain: 'dependency_supply_chain',
  MemorySafety: 'memory_safety',
  Availability: 'availability',
  Concurrency: 'concurrency',
  SecurityConfiguration: 'security_configuration',
  Other: 'other',
} as const;

export type CodeReviewFindingSecurityClass =
  (typeof CodeReviewFindingSecurityClass)[keyof typeof CodeReviewFindingSecurityClass];

// --- CodeReviewAgentConfig ---

export { CODE_REVIEW_PLATFORMS, type CodeReviewPlatform } from '@kilocode/app-shared/code-review';

export const ManuallyAddedRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
});

export type ManuallyAddedRepository = z.infer<typeof ManuallyAddedRepositorySchema>;

// --- Code Reviewer Council (enterprise multi-specialist review) ---

export const COUNCIL_SPECIALIST_ROLES = [
  'security',
  'performance',
  'testing',
  'correctness',
  'docs',
  'custom',
] as const;
export type CouncilSpecialistRole = (typeof COUNCIL_SPECIALIST_ROLES)[number];

// Council decision model v2: a vote is BINARY (yes/no). "warn"/"abstain" are NOT votes —
// a warning is a finding severity (see COUNCIL_FINDING_SEVERITIES), and a specialist that
// ran always votes (no-findings = pass). Votes are code-DERIVED from findings, never
// authored by the model. Same binary type is reused for the aggregate decision.
export const CouncilVoteSchema = z.enum(['pass', 'block']);
export type CouncilVote = z.infer<typeof CouncilVoteSchema>;

// Finding severity scale (v2). The LLM assigns one per finding — this is where its
// judgment lives. `critical` is the only BLOCKING severity: any critical finding makes the
// specialist's derived vote `block`; warning/suggestion/nitpick are informational.
export const COUNCIL_FINDING_SEVERITIES = ['critical', 'warning', 'suggestion', 'nitpick'] as const;
export const CouncilFindingSeveritySchema = z.enum(COUNCIL_FINDING_SEVERITIES);
export type CouncilFindingSeverity = (typeof COUNCIL_FINDING_SEVERITIES)[number];

// The single blocking severity: a finding at this level makes the specialist's derived vote
// `block`. Referenced by `isBlockingSeverity` so the blocking rule lives in exactly one place.
export const COUNCIL_BLOCKING_SEVERITY: CouncilFindingSeverity = 'critical';

/**
 * Review type for a run. 'standard' is the existing single-reviewer scan; 'council'
 * is a multi-specialist run. Extensible to future types.
 */
export const CODE_REVIEW_TYPES = ['standard', 'council'] as const;
export const CodeReviewTypeSchema = z.enum(CODE_REVIEW_TYPES);
export type CodeReviewType = z.infer<typeof CodeReviewTypeSchema>;

/** How a review run was requested (its origin). */
export const CODE_REVIEW_TRIGGER_SOURCES = ['manual', 'webhook'] as const;
export const CodeReviewTriggerSourceSchema = z.enum(CODE_REVIEW_TRIGGER_SOURCES);
export type CodeReviewTriggerSource = z.infer<typeof CodeReviewTriggerSourceSchema>;

// Governance mode (v2). Field is still named `aggregation_strategy` for continuity, but the
// values are the three DISTINCT modes under binary votes:
// - 'advisory'  — report votes/findings only; compute NO aggregate decision and NO merge gate.
// - 'unanimous' — block unless EVERY specialist votes pass (i.e. any block → block). Strict.
// - 'majority'  — block only when block votes outnumber pass votes. Lenient.
// (v1's 'any_blocking_member' is dropped: with no abstain, it is mathematically identical to
// 'unanimous'. 'advisory' is the safe default so a new council never blocks a merge unasked.)
export const COUNCIL_AGGREGATION_STRATEGIES = ['advisory', 'unanimous', 'majority'] as const;
export const CouncilAggregationStrategySchema = z.enum(COUNCIL_AGGREGATION_STRATEGIES);
export type CouncilAggregationStrategy = z.infer<typeof CouncilAggregationStrategySchema>;

// The safe default governance mode: report only, never gate a merge unasked. Single source of
// truth — referenced by the schema default, the manual-job UI state, dispatch, and the label
// fallback, so the default can't drift between the backend and what the UI initializes to.
export const DEFAULT_COUNCIL_AGGREGATION_STRATEGY: CouncilAggregationStrategy = 'advisory';

// A specialist id doubles as the cloud-agent-next `runtimeAgents[].slug` (single-session
// execution) AND the manifest correlation key, so it must satisfy the runtime-agent slug
// contract: start with a lowercase letter, only lowercase letters/digits/hyphens, max 50
// chars, and not collide with a built-in agent mode. Keep this in lockstep with
// cloud-agent-next's `RuntimeAgentSchema.slug` + `AgentModes` (services/cloud-agent-next/src/schema.ts).
// This must list EVERY built-in `AgentModes` value; a stale/partial copy lets a council id
// pass web validation but fail cloud-agent-next session preparation.
const RESERVED_AGENT_SLUGS = new Set([
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
]);

// Cloud-agent-next caps a runtime-agent model slug at this many chars
// (`Limits.MAX_RUNTIME_AGENT_MODEL_LENGTH`). Keep the per-specialist model constraint in
// lockstep so a council request valid at creation cannot fail at session preparation.
// Exported so the review-creation path can apply the SAME bound to the council BASE model
// (which specialists without an override inherit into `runtimeAgents[].model`).
export const MAX_RUNTIME_AGENT_MODEL_LENGTH = 200;

export const CouncilSpecialistSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(50)
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'Specialist id must be a runtime-agent slug (start with a lowercase letter; lowercase letters, digits, or hyphens; max 50 chars)'
    )
    .refine(
      id => !RESERVED_AGENT_SLUGS.has(id),
      'Specialist id must not collide with a built-in agent mode'
    ),
  role: z.enum(COUNCIL_SPECIALIST_ROLES),
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  required: z.boolean(),
  // What this specialist looks for; drives its prompt lens.
  lens: z.string().min(1).max(500),
  instructions: z.string().max(2_000).nullable().optional(),
  // Per-specialist model + thinking effort. In single-session execution these map to
  // cloud-agent-next `runtimeAgents[]` so each specialist sub-agent runs on its own
  // model; unset falls back to the review's default model. Bounded to the downstream
  // runtime-agent model limit so a valid council request can't fail at session prep.
  model_slug: z.string().max(MAX_RUNTIME_AGENT_MODEL_LENGTH).optional(),
  thinking_effort: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .nullable()
    .optional(),
});
export type CouncilSpecialist = z.infer<typeof CouncilSpecialistSchema>;

// The council definition: what the council IS (specialists + how their votes
// aggregate). It carries no trigger/selection logic — whether a given run is a
// council run is recorded per-run via `review_type`.
export const CodeReviewCouncilConfigSchema = z.object({
  // Whether the enterprise has council turned on. Lets specialists be configured
  // and retained while council is toggled off. Defaults true so an existing council
  // object (e.g. from a manual job) is treated as enabled.
  enabled: z.boolean().default(true),
  // Default 'advisory' — the safety net: a council runs and reports, but never blocks a merge
  // until an org explicitly picks unanimous/majority.
  //
  // Backward-compat (read boundary): `aggregation_strategy` is a PERSISTED field, so configs
  // written before the v2 rollout can hold the legacy v1 values `any_blocking_member` /
  // `unanimous_required`. Both meant "block on any block", which is exactly v2 `unanimous`, so
  // we normalize them here rather than throwing when a queued/completed pre-v2 council config
  // is re-parsed (`getManualCodeReviewConfig`). New values pass through unchanged.
  aggregation_strategy: z
    .preprocess(
      value =>
        value === 'any_blocking_member' || value === 'unanimous_required' ? 'unanimous' : value,
      CouncilAggregationStrategySchema
    )
    .default(DEFAULT_COUNCIL_AGGREGATION_STRATEGY),
  // Specialist ids must be unique: a specialist must not appear (and therefore vote)
  // more than once, or vote aggregation could be skewed by a duplicate.
  specialists: z
    .array(CouncilSpecialistSchema)
    .max(8)
    .superRefine((specialists, ctx) => {
      const seen = new Set<string>();
      for (const specialist of specialists) {
        if (seen.has(specialist.id)) {
          ctx.addIssue({ code: 'custom', message: `Duplicate specialist id: ${specialist.id}` });
          return;
        }
        seen.add(specialist.id);
      }
    }),
});
export type CodeReviewCouncilConfig = z.infer<typeof CodeReviewCouncilConfigSchema>;

// Single source of truth for one council finding, shared by BOTH the parse contract
// (the `kilo-code-review-council:v1` manifest in `@kilocode/worker-utils/code-review-council`)
// and the persisted council result below, so their bounds cannot drift apart.
export const CouncilFindingSchema = z.object({
  path: z.string().max(1024),
  line: z.number().int().nonnegative().nullable().optional(),
  // Severity MUST be one of the canonical scale (case/space-insensitive). Because the vote is
  // DERIVED from severity, a loose label would be unsafe: a real critical issue mislabeled
  // `high`/`sev1` would otherwise derive to `pass`. An off-scale label instead fails the
  // finding → the manifest is invalid → the decision fails closed (block). Casing/whitespace
  // is tolerated (normalized on read via `isBlockingSeverity`), but off-scale words are not.
  severity: z
    .string()
    .max(64)
    .refine(
      value =>
        (COUNCIL_FINDING_SEVERITIES as readonly string[]).includes(value.trim().toLowerCase()),
      'severity must be one of: critical, warning, suggestion, nitpick'
    ),
  rationale: z.string().max(4000),
});
export type CouncilFinding = z.infer<typeof CouncilFindingSchema>;

export const CouncilResultSpecialistSchema = z.object({
  id: z.string().max(64),
  role: z.enum(COUNCIL_SPECIALIST_ROLES),
  name: z.string().max(80),
  // The model/effort that actually ran this specialist (we assign these), for display.
  model: z.string().max(512).nullable(),
  thinkingEffort: z.string().max(50).nullable(),
  // Binary, CODE-DERIVED from this specialist's findings (any critical → block). NULL when the
  // specialist returned no reliable result (absent from / not captured in the manifest) — this
  // is "no result", NOT a `block` vote. The fail-closed AGGREGATE decision (enforcing modes)
  // is computed separately and still blocks on missing coverage.
  vote: CouncilVoteSchema.nullable(),
  highestSeverity: z.string().max(64).nullable(),
  findings: z.array(CouncilFindingSchema).max(200),
});
export type CouncilResultSpecialist = z.infer<typeof CouncilResultSpecialistSchema>;

// Persisted OUTCOME of a council run, surfaced on the cloud UI job-runs screen (manual
// council runs are not posted to a PR). The capture code maps the parsed
// `kilo-code-review-council:v1` manifest + the code-owned decision into this storage contract.
export const CodeReviewCouncilResultSchema = z.object({
  // The code-owned governance decision (never model-authored). NULL in `advisory` mode —
  // there is no aggregate verdict, only the per-specialist votes/findings.
  decision: CouncilVoteSchema.nullable(),
  aggregationStrategy: CouncilAggregationStrategySchema,
  specialists: z.array(CouncilResultSpecialistSchema).max(8),
});
export type CodeReviewCouncilResult = z.infer<typeof CodeReviewCouncilResultSchema>;

// Per-repository model override. Ties a repository to a specific model so a repo
// can run its standard review on a different model than the global default. A repo
// without an entry here uses the config's global `model_slug`.
//
// Two identifiers are stored intentionally, each serving a lookup the other can't:
//   - `repository_id` matches `selected_repository_ids` (GitHub/GitLab numeric,
//     Bitbucket UUID). Used at save time for selection/pruning parity.
//   - `repo_full_name` is the platform's canonical full name and the ONLY repo
//     identifier persisted on the review row, so it is what the dispatch-time model
//     lookup matches against (numeric IDs are not on the row for GitHub/Bitbucket).
export const RepositoryModelOverrideSchema = z.object({
  // Matched by exact value and type against the platform repository ID — never coerced.
  repository_id: z.union([z.number(), z.string()]),
  // "owner/repo" (GitHub), path_with_namespace (GitLab), "workspace/slug" (Bitbucket).
  repo_full_name: z.string().max(511),
  model_slug: z.string().max(512),
  // Thinking effort variant name (e.g. "high", "max") — null means model default,
  // matching the global `thinking_effort` field below.
  thinking_effort: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .nullable()
    .optional(),
});
export type RepositoryModelOverride = z.infer<typeof RepositoryModelOverrideSchema>;

export const CodeReviewAgentConfigSchema = z.object({
  review_style: z.enum(REVIEW_STYLES),
  focus_areas: z.array(z.string()),
  // Optional enterprise council configuration. Absent = existing single-reviewer behavior.
  council: CodeReviewCouncilConfigSchema.optional(),
  auto_approve_minor: z.boolean().optional(),
  custom_instructions: z.string().nullable().optional(),
  model_slug: z.string(),
  // Thinking effort variant name (e.g. "high", "max", "thinking") — null means model default
  thinking_effort: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .nullable()
    .optional(),
  repository_selection_mode: z.enum(['all', 'selected']).optional(),
  selected_repository_ids: z.array(z.union([z.number(), z.string()])).optional(),
  // Manually added repositories (for GitLab where pagination limits results)
  manually_added_repositories: z.array(ManuallyAddedRepositorySchema).optional(),
  // Per-repository model overrides. Absent/empty = every repo uses the global model_slug.
  repository_model_overrides: z.array(RepositoryModelOverrideSchema).optional(),
  disable_review_md: z.boolean().optional(),
  // Controls when the PR gate check (GitHub Check Run / GitLab commit status)
  // reports a failure based on review findings.
  //   'off'      — gate only fails on system errors (timeout, crash)
  //   'all'      — gate fails on any finding
  //   'warning'  — gate fails on warnings and above
  //   'critical' — gate fails only on critical issues
  gate_threshold: z.enum(GATE_THRESHOLDS).optional(),
  review_memory_enabled: z.boolean().optional(),
  review_analytics_enabled: z.boolean().optional(),
});

export type CodeReviewAgentConfig = z.infer<typeof CodeReviewAgentConfigSchema>;

export const ManualCodeReviewConfigSchema = z
  .object({
    agentConfig: CodeReviewAgentConfigSchema,
    instructions: z.string().max(4_000).nullable(),
    outputMode: z.enum(['provider', 'kilo']),
  })
  .strict();

export type ManualCodeReviewConfig = z.infer<typeof ManualCodeReviewConfigSchema>;

// --- Security types ---

export const DependabotAlertState = {
  OPEN: 'open',
  FIXED: 'fixed',
  DISMISSED: 'dismissed',
  AUTO_DISMISSED: 'auto_dismissed',
} as const;

export type DependabotAlertState = (typeof DependabotAlertState)[keyof typeof DependabotAlertState];

export const SecuritySeverity = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const;

export type SecuritySeverity = (typeof SecuritySeverity)[keyof typeof SecuritySeverity];

export const SecurityFindingNotificationKind = {
  NewFinding: 'new_finding',
  SlaWarning: 'sla_warning',
  SlaBreach: 'sla_breach',
} as const;

export type SecurityFindingNotificationKind =
  (typeof SecurityFindingNotificationKind)[keyof typeof SecurityFindingNotificationKind];

export const SecurityFindingNotificationStatus = {
  Staged: 'staged',
  Pending: 'pending',
  Sending: 'sending',
  Sent: 'sent',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type SecurityFindingNotificationStatus =
  (typeof SecurityFindingNotificationStatus)[keyof typeof SecurityFindingNotificationStatus];

export type DependabotAlertRaw = {
  number: number;
  state: DependabotAlertState;
  dependency: {
    package: {
      ecosystem: string;
      name: string;
    };
    manifest_path: string;
    scope: 'development' | 'runtime' | null;
  };
  security_advisory: {
    ghsa_id: string;
    cve_id: string | null;
    summary: string;
    description: string;
    severity: SecuritySeverity;
    cvss?: {
      score: number;
      vector_string: string;
    };
    cwes?: Array<{
      cwe_id: string;
      name: string;
    }>;
  };
  security_vulnerability: {
    vulnerable_version_range: string;
    first_patched_version?: {
      identifier: string;
    };
  };
  created_at: string;
  updated_at: string;
  fixed_at: string | null;
  dismissed_at: string | null;
  dismissed_by?: {
    login: string;
  } | null;
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
  auto_dismissed_at?: string | null;
  html_url: string;
  url: string;
};

export type SecurityFindingTriage = {
  needsSandboxAnalysis: boolean;
  needsSandboxReasoning: string;
  suggestedAction: 'dismiss' | 'analyze_codebase' | 'manual_review';
  confidence: 'high' | 'medium' | 'low';
  triageAt: string;
};

export const SandboxSuggestedAction = {
  DISMISS: 'dismiss',
  OPEN_PR: 'open_pr',
  MANUAL_REVIEW: 'manual_review',
  MONITOR: 'monitor',
} as const;

export type SandboxSuggestedAction =
  (typeof SandboxSuggestedAction)[keyof typeof SandboxSuggestedAction];

export type SecurityFindingSandboxAnalysis = {
  isExploitable: boolean | 'unknown';
  extractionStatus?: 'succeeded' | 'failed';
  exploitabilityReasoning: string;
  usageLocations: string[];
  suggestedFix: string;
  suggestedAction: SandboxSuggestedAction;
  summary: string;
  rawMarkdown: string;
  analysisAt: string;
  modelUsed?: string;
};

export type SecurityFindingAnalysisInput = {
  schemaVersion: 1;
  source: string;
  sourceId: string;
  sourceUpdatedAt: string | null;
  repoFullName: string;
  status: string;
  severity: string | null;
  packageName: string;
  packageEcosystem: string;
  dependencyScope: string | null;
  cveId: string | null;
  ghsaId: string | null;
  cweIds: string[];
  cvssScore: string | null;
  title: string;
  description: string | null;
  vulnerableVersionRange: string | null;
  patchedVersion: string | null;
  manifestPath: string | null;
};

export type SecurityFindingAnalysis = {
  triage?: SecurityFindingTriage;
  sandboxAnalysis?: SecurityFindingSandboxAnalysis;
  findingDataSnapshot?: SecurityFindingAnalysisInput;
  rawMarkdown?: string;
  analyzedAt: string;
  modelUsed?: string;
  triageModel?: string;
  analysisModel?: string;
  triggeredByUserId?: string;
  correlationId?: string;
};

// --- OpenRouter types ---

export type OpenRouterPricing = z.infer<typeof OpenRouterPricing>;
export const OpenRouterPricing = z.object({
  prompt: z.string(),
  completion: z.string(),
});

export type OpenRouterBaseModel = z.infer<typeof OpenRouterBaseModel>;
export const OpenRouterBaseModel = z.object({
  slug: z.string(),
  name: z.string(),
  author: z.string(),
  description: z.string(),
  context_length: z.number(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  group: z.string(),
  updated_at: z.string(),
});

export type OpenRouterEndpoint = z.infer<typeof OpenRouterEndpoint>;
export const OpenRouterEndpoint = z.object({
  provider_display_name: z.string(),
  is_free: z.boolean(),
  pricing: OpenRouterPricing,
  data_policy: z
    .object({
      training: z.boolean().optional(),
      retainsPrompts: z.boolean().optional(),
    })
    .nullish(),
});

export type OpenRouterModel = z.infer<typeof OpenRouterModel>;
export const OpenRouterModel = OpenRouterBaseModel.extend({
  endpoint: OpenRouterEndpoint.nullable(),
});

export type OpenRouterSearchResponse = z.infer<typeof OpenRouterSearchResponse>;
export const OpenRouterSearchResponse = z.object({
  data: z.object({
    models: z.array(OpenRouterModel),
  }),
});

export type OpenRouterProvider = z.infer<typeof OpenRouterProvider>;
export const OpenRouterProvider = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  dataPolicy: z.object({
    training: z.boolean(),
    retainsPrompts: z.boolean(),
    canPublish: z.boolean(),
  }),
  headquarters: z.string().optional(),
  datacenters: z.array(z.string()).optional(),
  icon: z
    .object({
      url: z.string(),
      className: z.string().optional(),
    })
    .optional(),
});

export type OpenRouterProvidersResponse = z.infer<typeof OpenRouterProvidersResponse>;
export const OpenRouterProvidersResponse = z.union([
  z.object({
    data: z.array(OpenRouterProvider),
  }),
  z.array(OpenRouterProvider),
]);

export type NormalizedProvider = z.infer<typeof NormalizedProvider>;
export const NormalizedProvider = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  dataPolicy: z.object({
    training: z.boolean(),
    retainsPrompts: z.boolean(),
    canPublish: z.boolean(),
  }),
  headquarters: z.string().optional(),
  datacenters: z.array(z.string()).optional(),
  icon: z
    .object({
      url: z.string(),
      className: z.string().optional(),
    })
    .optional(),
  models: z.array(OpenRouterModel),
});

export type NormalizedOpenRouterResponse = z.infer<typeof NormalizedOpenRouterResponse>;
export const NormalizedOpenRouterResponse = z.object({
  providers: z.array(NormalizedProvider),
  total_providers: z.number(),
  total_models: z.number(),
  generated_at: z.string(),
});

export const OpenCodePromptSchema = z.enum([
  'codex',
  'gemini',
  'beast',
  'anthropic',
  'trinity',
  'anthropic_without_todo',
  'ling',
  'gpt55',
]);

export type OpenCodePrompt = z.infer<typeof OpenCodePromptSchema>;

export const OpenCodeFamilySchema = z.enum(['claude', 'gpt', 'gemini', 'llama', 'mistral']);

export type OpenCodeFamily = z.infer<typeof OpenCodeFamilySchema>;

export const VerbositySchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export type Verbosity = z.infer<typeof VerbositySchema>;

export const ReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const CustomLlmProviderSchema = z.enum([
  'anthropic', // uses Messages API
  'openai', // uses Responses API
  'openai-compatible', // uses Chat Completions API with reasoning_content
  'openrouter', // uses Chat Completions API with reasoning_details
  'alibaba', // identical to openai-compatible, but reports cache write tokens that alibaba bills separately
  'mistral', // uses Chat Completions API with possibly complex content objects for e.g. thinking
]);

export type CustomLlmProvider = z.infer<typeof CustomLlmProviderSchema>;

export const OpenCodeVariantSchema = z.object({
  verbosity: VerbositySchema.optional(),
  reasoning: z
    .object({
      enabled: z.boolean().optional(),
      effort: ReasoningEffortSchema.optional(),
    })
    .optional(),
});

export type OpenCodeVariant = z.infer<typeof OpenCodeVariantSchema>;

export const OpenCodeSettingsSchema = z.object({
  ai_sdk_provider: CustomLlmProviderSchema.optional(),
  family: OpenCodeFamilySchema.optional(),
  prompt: OpenCodePromptSchema.optional(),
  variants: z.record(z.string(), OpenCodeVariantSchema).optional(),
});

export type OpenCodeSettings = z.infer<typeof OpenCodeSettingsSchema>;

export const CustomLlmExtraBodySchema = z.record(z.string(), z.any());

export type CustomLlmExtraBody = z.infer<typeof CustomLlmExtraBodySchema>;

export const CustomLlmExtraHeadersSchema = z.record(z.string(), z.string());

export type CustomLlmExtraHeaders = z.infer<typeof CustomLlmExtraHeadersSchema>;

// All price fields are in dollars per token (e.g. "0.000001" = $1 per million tokens),
// matching the OpenRouter pricing convention.
export const CustomLlmPricingSchema = z.object({
  prompt: z.string(),
  completion: z.string(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
});

export type CustomLlmPricing = z.infer<typeof CustomLlmPricingSchema>;

export const CustomLlmMetadataSchema = z.object({
  context_length: z.number(),
  max_completion_tokens: z.number(),
  supports_image_input: z.boolean().optional(),
  opencode_settings: OpenCodeSettingsSchema.optional(),
});

export type CustomLlmMetadata = z.infer<typeof CustomLlmMetadataSchema>;

export const CustomLlmCompressionSchema = z.object({
  enabled: z.literal(true),
  base_url: z.url().optional(),
  api_key: z.string().optional(),
  model_alias: z.string(),
});

export type CustomLlmCompression = z.infer<typeof CustomLlmCompressionSchema>;

export const CustomLlmApiConfigSchema = z.object({
  internal_id: z.string().min(1),
  base_url: z.url(),
  add_cache_breakpoints: z.boolean().optional(),
  remove_cache_breakpoints: z.boolean().optional(),
  inject_reasoning_into_content: z.boolean().optional(),
  extra_headers: CustomLlmExtraHeadersSchema.optional(),
  extra_body: CustomLlmExtraBodySchema.optional(),
  remove_from_body: z.array(z.string()).optional(),
  compression: CustomLlmCompressionSchema.optional(),
});

export type CustomLlmApiConfig = z.infer<typeof CustomLlmApiConfigSchema>;

export const CustomLlmDefinitionSchema = z
  .object({
    display_name: z.string(),
    api_key: z.string(),
    organization_ids: z.array(z.string()),
    pricing: CustomLlmPricingSchema.optional(),
  })
  .and(CustomLlmMetadataSchema)
  .and(CustomLlmApiConfigSchema);

export type CustomLlmDefinition = z.infer<typeof CustomLlmDefinitionSchema>;

// --- StoredModel ---

export const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['language', 'embedding', 'image']).optional().catch(undefined),
});

export const ModelsSchema = z.object({ data: z.array(ModelSchema) });

export const EndpointSchema = z.object({
  tag: z.string().optional(),
  provider_name: z.string().optional(),
  context_length: z.number().optional(),
  pricing: z
    .object({
      prompt: z.string(),
      completion: z.string(),
      image: z.string().optional(),
      request: z.string().optional(),
      input_cache_read: z.string().optional(),
      input_cache_write: z.string().optional(),
      web_search: z.string().optional(),
      internal_reasoning: z.string().optional(),
      discount: z.number().optional(),
    })
    .optional(),
});

export type Endpoint = z.infer<typeof EndpointSchema>;

export const EndpointsSchema = z.object({
  data: z.object({ endpoints: z.array(EndpointSchema) }),
});

export const StoredModelSchema = ModelSchema.and(
  z.object({
    endpoints: z.array(EndpointSchema),
  })
);

export type StoredModel = z.infer<typeof StoredModelSchema>;

// =============================================================================
// C. Stripe type (inline)
// =============================================================================

export type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

// --- Code review terminal reasons ---

/**
 * Valid values for cloud_agent_code_reviews.terminal_reason.
 * KEEP IN SYNC with CloudAgentTerminalReason in
 * packages/worker-utils/src/cloud-agent-next-client.ts — both lists must
 * contain the same literal values.
 */
export const CODE_REVIEW_TERMINAL_REASONS = [
  'billing',
  'model_not_found',
  'github_installation_required',
  'github_ip_allow_list',
  'gitlab_project_access_required',
  'byok_invalid_key',
  'selected_model_unavailable',
  'repeated_repository_clone_timeout',
  'user_cancelled',
  'superseded',
  'interrupted',
  'timeout',
  'upstream_error',
  'sandbox_error',
  'unknown',
] as const;

export type CodeReviewTerminalReason = (typeof CODE_REVIEW_TERMINAL_REASONS)[number];

/**
 * Subset of CODE_REVIEW_TERMINAL_REASONS that represent expected, non-system
 * outcomes (user/billing-driven cancellations or supersession). Alerting
 * detectors exclude these so they are not counted as system failures.
 *
 * KEEP IN SYNC with CODE_REVIEW_TERMINAL_REASONS — when adding a new reason
 * above, decide whether it is a system failure or a benign outcome and
 * include it here when it is the latter.
 */
export const CODE_REVIEW_BENIGN_TERMINAL_REASONS = [
  'billing',
  'model_not_found',
  'github_installation_required',
  'github_ip_allow_list',
  'gitlab_project_access_required',
  'byok_invalid_key',
  'selected_model_unavailable',
  'user_cancelled',
  'superseded',
] as const satisfies readonly CodeReviewTerminalReason[];

export type CodeReviewBenignTerminalReason = (typeof CODE_REVIEW_BENIGN_TERMINAL_REASONS)[number];

// --- MCP Gateway enums ---

export const MCPGatewayOwnerScope = {
  Personal: 'personal',
  Organization: 'organization',
} as const;

export type MCPGatewayOwnerScope = (typeof MCPGatewayOwnerScope)[keyof typeof MCPGatewayOwnerScope];

export const MCPGatewayAuthMode = {
  None: 'none',
  StaticHeaders: 'static_headers',
  OAuthDynamic: 'oauth_dynamic',
  OAuthStatic: 'oauth_static',
} as const;

export type MCPGatewayAuthMode = (typeof MCPGatewayAuthMode)[keyof typeof MCPGatewayAuthMode];

export const MCPGatewaySharingMode = {
  SingleUser: 'single_user',
  MultiUser: 'multi_user',
} as const;

export type MCPGatewaySharingMode =
  (typeof MCPGatewaySharingMode)[keyof typeof MCPGatewaySharingMode];

export const MCPGatewayProviderScopeSource = {
  None: 'none',
  Discovered: 'discovered',
  Override: 'override',
} as const;

export type MCPGatewayProviderScopeSource =
  (typeof MCPGatewayProviderScopeSource)[keyof typeof MCPGatewayProviderScopeSource];

export const MCPGatewayRouteStatus = {
  Active: 'active',
  Rotated: 'rotated',
  Revoked: 'revoked',
} as const;

export type MCPGatewayRouteStatus =
  (typeof MCPGatewayRouteStatus)[keyof typeof MCPGatewayRouteStatus];

export const MCPGatewayInstanceStatus = {
  Active: 'active',
  NeedsReauth: 'needs_reauth',
  Revoked: 'revoked',
  Removed: 'removed',
} as const;

export type MCPGatewayInstanceStatus =
  (typeof MCPGatewayInstanceStatus)[keyof typeof MCPGatewayInstanceStatus];

export const MCPGatewayProviderGrantStatus = {
  Active: 'active',
  Revoked: 'revoked',
} as const;

export type MCPGatewayProviderGrantStatus =
  (typeof MCPGatewayProviderGrantStatus)[keyof typeof MCPGatewayProviderGrantStatus];

export const MCPGatewayOAuthGrantStatus = {
  Pending: 'pending',
  Active: 'active',
  Revoked: 'revoked',
} as const;

export type MCPGatewayOAuthGrantStatus =
  (typeof MCPGatewayOAuthGrantStatus)[keyof typeof MCPGatewayOAuthGrantStatus];

export const MCPGatewaySecretKind = {
  StaticProviderCredentials: 'static_provider_credentials',
  DynamicRegistration: 'dynamic_registration',
  StaticHeaders: 'static_headers',
} as const;

export type MCPGatewaySecretKind = (typeof MCPGatewaySecretKind)[keyof typeof MCPGatewaySecretKind];

export const MCPGatewayOAuthClientAuthMethod = {
  None: 'none',
  ClientSecretPost: 'client_secret_post',
  ClientSecretBasic: 'client_secret_basic',
} as const;

export type MCPGatewayOAuthClientAuthMethod =
  (typeof MCPGatewayOAuthClientAuthMethod)[keyof typeof MCPGatewayOAuthClientAuthMethod];

export const MCPGatewayAuthorizationRequestStatus = {
  Pending: 'pending',
  Completed: 'completed',
  Error: 'error',
} as const;

export type MCPGatewayAuthorizationRequestStatus =
  (typeof MCPGatewayAuthorizationRequestStatus)[keyof typeof MCPGatewayAuthorizationRequestStatus];

export const MCPGatewayPendingProviderAuthorizationStatus = {
  Pending: 'pending',
  Completed: 'completed',
  Error: 'error',
} as const;

export type MCPGatewayPendingProviderAuthorizationStatus =
  (typeof MCPGatewayPendingProviderAuthorizationStatus)[keyof typeof MCPGatewayPendingProviderAuthorizationStatus];

export const MCPGatewayAuditOutcome = {
  Success: 'success',
  Failure: 'failure',
  Blocked: 'blocked',
} as const;

export type MCPGatewayAuditOutcome =
  (typeof MCPGatewayAuditOutcome)[keyof typeof MCPGatewayAuditOutcome];
