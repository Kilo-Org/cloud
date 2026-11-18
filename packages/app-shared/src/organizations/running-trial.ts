export {
  /**
   * The stages in which a trial is still running, and the predicate that tests
   * a status against them: the server's own classification from
   * `@kilocode/organization-entitlement`, re-exported here so the apps read one
   * answer. `organizations.list` publishes a stage only from this set, and a
   * client renders "on trial" over the same predicate instead of carrying a
   * mirrored copy that can drift.
   */
  isRunningTrialStage,
  RUNNING_TRIAL_STAGES,
} from '@kilocode/organization-entitlement';
export type { RunningTrialStage } from '@kilocode/organization-entitlement';
