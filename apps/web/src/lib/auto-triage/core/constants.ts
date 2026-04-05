/**
 * Auto Triage Constants
 *
 * Centralized constants for auto-triage system configuration.
 * These values control concurrency, timeouts, thresholds, and pagination.
 */

export const AUTO_TRIAGE_CONSTANTS = {
  /**
   * Maximum number of tickets that can be actively analyzed concurrently per owner.
   * This prevents overwhelming the system and ensures fair resource distribution.
   */
  MAX_CONCURRENT_TICKETS_PER_OWNER: 10,

  /**
   * Timeout for fetch requests to the triage worker (in milliseconds).
   * Requests exceeding this duration will be aborted.
   */
  WORKER_FETCH_TIMEOUT: 10_000,

  /**
   * Timeout for cloud agent operations (in milliseconds).
   * Cloud agent has 5 minutes to complete triage analysis.
   */
  CLOUD_AGENT_TIMEOUT: 300_000, // 5 minutes

  /**
   * Default confidence threshold for marking issues as duplicates.
   * Value between 0 and 1, where 1 is 100% confidence.
   */
  DEFAULT_DUPLICATE_THRESHOLD: 0.8,

  /**
   * Default confidence threshold for automatically creating PRs.
   * Value between 0 and 1, where 1 is 100% confidence.
   * Higher threshold ensures only high-confidence fixes get automated PRs.
   */
  DEFAULT_AUTO_PR_THRESHOLD: 0.8,

  /**
   * Minimum confidence score required to take any automated action.
   * Actions below this threshold will be flagged for manual review.
   */
  MIN_CONFIDENCE_FOR_ACTION: 0.7,

  /**
   * Default number of items to return per page in paginated results.
   */
  DEFAULT_PAGE_SIZE: 50,

  /**
   * Maximum number of items allowed per page in paginated results.
   * Prevents excessive data transfer and performance issues.
   */
  MAX_PAGE_SIZE: 100,
} as const;

/**
 * Type helper to extract constant values
 */
export type AutoTriageConstants = typeof AUTO_TRIAGE_CONSTANTS;
