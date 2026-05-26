export const SLOW_REVIEW_WINDOW_MINUTES = 120;
export const SLOW_REVIEW_DURATION_MINUTES = 60;
export const SLOW_REVIEW_RATE_THRESHOLD = 0.1;

export const ERROR_SPIKE_WINDOW_MINUTES = 30;
export const ERROR_SPIKE_RATE_THRESHOLD = 0.2;

export type CodeReviewAlertSeverity = 'page' | 'ticket';
export const CODE_REVIEW_ALERT_SEVERITY = 'ticket' satisfies CodeReviewAlertSeverity;
