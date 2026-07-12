// Pure classification of a device-auth poll response's HTTP status. Kept
// free of any react-native/expo imports so it can be unit tested directly.
type PollOutcome =
  | { readonly status: 'approved' }
  | { readonly status: 'pending' }
  | { readonly status: 'denied'; readonly message: string }
  | { readonly status: 'expired'; readonly message: string }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'retry' };

export function classifyPollResponse(httpStatus: number): PollOutcome {
  if (httpStatus === 200) {
    return { status: 'approved' };
  }
  if (httpStatus === 202) {
    return { status: 'pending' };
  }
  if (httpStatus === 403) {
    return { status: 'denied', message: 'Access denied by user' };
  }
  if (httpStatus === 410) {
    return { status: 'expired', message: 'Code expired' };
  }
  // 429/5xx are transient (rate limiting or a flaky server) — keep polling.
  if (httpStatus === 429 || httpStatus >= 500) {
    return { status: 'retry' };
  }
  // Any other 4xx (400, 401, ...) is not something retrying will fix — and
  // 1xx/3xx are statuses this endpoint never returns, so treat them the same.
  return { status: 'error', message: 'Sign-in failed. Please try again.' };
}
