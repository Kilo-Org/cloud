/**
 * Shared moderation contracts for the web and mobile apps.
 *
 * Values must stay in sync with the moderation schema and router in
 * `apps/web` (see the moderation slice of the plan). Keep these as `as const`
 * arrays so both apps and Zod schemas can consume one source of truth.
 */

export const MODERATION_SURFACES = [
  'ai_output',
  'pr_discussion_content',
  'pr_discussion_user',
] as const;
export type ModerationSurface = (typeof MODERATION_SURFACES)[number];

export const MODERATION_REASONS = ['harmful', 'illegal', 'harassment', 'spam', 'other'] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];

export const MODERATION_TRIAGE_STATUSES = ['received', 'open', 'actioned', 'rejected'] as const;
export type ModerationTriageStatus = (typeof MODERATION_TRIAGE_STATUSES)[number];

export const MODERATION_APPEAL_STATUSES = ['none', 'submitted', 'accepted', 'rejected'] as const;
export type ModerationAppealStatus = (typeof MODERATION_APPEAL_STATUSES)[number];

/** Current UGC Terms version. Bump only when the legal copy changes. */
export const CURRENT_UGC_TERMS_VERSION = 'ugc-2026-08-17';

/** Age posture recorded with a Terms acceptance. */
export const UGC_AGE_POSTURE = '13_plus' as const;
export type UgcAgePosture = typeof UGC_AGE_POSTURE;
