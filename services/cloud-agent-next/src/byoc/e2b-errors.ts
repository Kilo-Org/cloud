const messages = {
  byoc_e2b_credential_missing:
    'The E2B connection is no longer available. Ask an organization administrator to check compute settings.',
  byoc_e2b_credential_invalid:
    'The E2B connection is invalid. Ask an organization administrator to check the API key.',
  byoc_e2b_consent_missing:
    'The E2B connection requires the current direct-token consent. Ask an organization administrator to reconnect it.',
  byoc_e2b_template_unavailable:
    'The approved E2B runtime template is unavailable. Contact support before retrying.',
  byoc_e2b_capacity: 'E2B compute capacity is unavailable. Check the E2B project limits.',
  byoc_e2b_create_unknown:
    'E2B sandbox creation has an unknown outcome. This worktree is blocked pending investigation; no replacement was created.',
  byoc_e2b_bootstrap_failed:
    'The E2B sandbox could not start the Cloud Agent runtime. Retry after cleanup completes.',
  byoc_e2b_unavailable: 'E2B compute is temporarily unavailable. Try again later.',
  byoc_e2b_lifetime_exceeded:
    'The E2B sandbox reached its one-hour allocation limit. Send a new message after cleanup to restore this chat.',
  byoc_e2b_policy_mismatch:
    'The E2B worktree credential policy is invalid. This worktree cannot start.',
} as const;

export type E2BFailureCode = keyof typeof messages;

export function e2bFailureMessage(reason: string): string | undefined {
  return Object.entries(messages).find(([code]) => code === reason)?.[1];
}

export class E2BProviderError extends Error {
  constructor(readonly code: E2BFailureCode) {
    super(messages[code]);
    this.name = 'E2BProviderError';
  }
}
