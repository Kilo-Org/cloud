import { z } from 'zod';

export const KILOCLAW_START_REASONS = [
  'initial_provision',
  'manual_user_request',
  'admin_request',
  'interrupted_auto_resume',
  'snapshot_restore',
  'crash_recovery',
] as const;

export type KiloclawStartReason = (typeof KILOCLAW_START_REASONS)[number];

export const KiloclawStartReasonSchema = z.enum(KILOCLAW_START_REASONS);

export const KILOCLAW_STOP_REASONS = [
  'manual_user_request',
  'admin_request',
  'trial_expiry',
  'subscription_expiry',
  'past_due_cleanup',
  'trial_inactivity',
  'snapshot_restore',
] as const;

export type KiloclawStopReason = (typeof KILOCLAW_STOP_REASONS)[number];

export const KiloclawStopReasonSchema = z.enum(KILOCLAW_STOP_REASONS);

export const KILOCLAW_DESTROY_REASONS = [
  'manual_user_request',
  'admin_request',
  'org_member_cleanup',
  'destruction_deadline_elapsed',
  'bootstrap_cleanup_failure',
  'stale_provision_cleanup',
] as const;

export type KiloclawDestroyReason = (typeof KILOCLAW_DESTROY_REASONS)[number];

export const KiloclawDestroyReasonSchema = z.enum(KILOCLAW_DESTROY_REASONS);
