export {
  /**
   * The stage predicate the server publishes on, and the record it reads: for
   * every stage of the trial, whether a trial in it is still running. Both come
   * from `@kilocode/organization-entitlement`, so the publisher and every
   * client read one classification instead of mirrors that can drift.
   * `organizations.list` publishes a stage only when the record answers true.
   */
  isRunningTrialStage,
  TRIAL_STAGE_RUNNING,
} from '@kilocode/organization-entitlement';
export type { RunningTrialStage } from '@kilocode/organization-entitlement';
