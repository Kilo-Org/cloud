export const CODE_REVIEW_ALERT_WINDOW_MINUTES = 30;

export const FAILURE_RATE_THRESHOLD = 0.25;
export const FAILURE_RATE_MIN_TERMINAL = 8;

export const STUCK_QUEUED_MINUTES = 15;
export const STUCK_RUNNING_MINUTES = 120;
export const STUCK_COUNT_THRESHOLD = 5;

export const NO_COMPLETIONS_MIN_CREATED = 5;

export const ERROR_SPIKE_FRACTION = 0.5;
export const ERROR_SPIKE_MIN_FAILURES = 6;

export type CodeReviewAlertSeverity = 'page' | 'ticket';
export const CODE_REVIEW_ALERT_SEVERITY = 'ticket' satisfies CodeReviewAlertSeverity;
