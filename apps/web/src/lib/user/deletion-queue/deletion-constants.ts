export const USER_DELETION_CATALOG_VERSION = 2;
export const USER_DELETION_MAX_ORDINARY_ATTEMPTS = 8;
export const USER_DELETION_RETRY_BASE_MS = 60_000;
export const USER_DELETION_RETRY_CAP_MS = 60 * 60 * 1000;
export const USER_DELETION_RATE_LIMIT_ATTENTION_MS = 24 * 60 * 60 * 1000;
export const USER_DELETION_TASK_LEASE_MS = 65_000;
export const USER_DELETION_INTERNAL_DEADLINE_MS = 50_000;
export const USER_DELETION_OUTCOME_PERSIST_RESERVE_MS = 5_000;
export const USER_DELETION_STOP_STARTING_RESERVE_MS = 10_000;
export const USER_DELETION_ANONYMIZE_MIN_REMAINING_MS = 35_000;
export const USER_DELETION_ANONYMIZE_TIMEOUT_BUFFER_MS = 2_000;
export const USER_DELETION_ANONYMIZE_MIN_STATEMENT_TIMEOUT_MS = 5_000;
export const USER_DELETION_PROVIDER_TIMEOUT_MS = 8_000;
export const USER_DELETION_MAX_CONCURRENT_TASKS = 2;
export const USER_DELETION_RESOURCE_BATCH_SIZE = 10;
export const USER_DELETION_USAGE_PREFIX_BATCH_SIZE = 1_000;
export const USER_DELETION_USAGE_PREFIX_STATEMENT_TIMEOUT_MS = 8_000;
export const USER_DELETION_CONTINUE_DELAY_MS = 1_000;
export const USER_DELETION_POSTHOG_MAX_VERIFY_ATTEMPTS = 3;
export const USER_DELETION_SUBSTACK_TIMEOUT_MS = 15_000;
export const USER_DELETION_SUBSTACK_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
export const USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL = 'https://blog.kilo.ai';
export const USER_DELETION_SUBSTACK_MANUAL_URL =
  'https://kilocode.substack.com/publish/subscribers';
export const USER_DELETION_PYLON_DELETE_COMPLETE_TAG = 'delete-complete';
export const USER_DELETION_PYLON_DELETE_READY_TAG = 'delete-ready';
export const USER_DELETION_KILOCODE_APP_EMAIL = 'hi@app.kilocode.ai';
export const USER_DELETION_STALE_REQUEST_MS = 7 * 24 * 60 * 60 * 1000;
export const USER_DELETION_PYLON_REPLY_HTML =
  'This email is your confirmation that the Kilo account associated with this email address has been permanently deleted and anonymized.<br /><br />Your account will be deleted in our case management system immediately after this email. Please do not respond to this email, as it will automatically re-create your account in the system.';
export const USER_DELETION_SESSION_INGEST_AUDIENCE = 'session-ingest:user-deletion';
export const USER_DELETION_PYLON_API_BASE = 'https://api.usepylon.com';
export const USER_DELETION_CUSTOMERIO_TRACK_BASE = 'https://track.customer.io';
export const USER_DELETION_DEFAULT_POSTHOG_HOST = 'https://us.posthog.com';
export const USER_DELETION_SUBSTACK_PAGE_SIZE = 50;
