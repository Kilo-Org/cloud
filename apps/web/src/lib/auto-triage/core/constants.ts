export const AUTO_TRIAGE_CONSTANTS = {
  MAX_CONCURRENT_TICKETS_PER_OWNER: 10,

  WORKER_FETCH_TIMEOUT: 10_000,

  /**
   * Timeout for cloud agent operations (in milliseconds).
   * Cloud agent has 5 minutes to complete triage analysis.
   */
  CLOUD_AGENT_TIMEOUT: 300_000, // 5 minutes

  DEFAULT_DUPLICATE_THRESHOLD: 0.8,

  DEFAULT_AUTO_PR_THRESHOLD: 0.8,

  /**
   * Minimum confidence score required to take any automated action.
   * Actions below this threshold will be flagged for manual review.
   */
  MIN_CONFIDENCE_FOR_ACTION: 0.7,

  DEFAULT_PAGE_SIZE: 50,

  MAX_PAGE_SIZE: 100,
} as const;

export type AutoTriageConstants = typeof AUTO_TRIAGE_CONSTANTS;
