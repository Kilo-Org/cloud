export const CODE_REVIEW_ACTION_REQUIRED_RUNTIME_STATE_KEY = 'code_review_action_required';

export const CODE_REVIEW_ACTION_REQUIRED_REASONS = [
  'github_installation_required',
  'github_ip_allow_list',
  'byok_invalid_key',
  'selected_model_unavailable',
] as const;

export type CodeReviewActionRequiredReason = (typeof CODE_REVIEW_ACTION_REQUIRED_REASONS)[number];

export type CodeReviewActionRequiredState = {
  reason: CodeReviewActionRequiredReason;
  detectedAt: string;
  lastSeenAt: string;
  triggeringReviewId?: string;
  lastErrorMessage: string;
  emailSentAt?: string;
};

export type CodeReviewActionRequiredCopy = {
  title: string;
  description: string;
  recoveryLabel: string;
  emailReason: string;
  checkTitle: string;
  checkSummary: string;
  gitlabDescription: string;
};

const COPY_BY_REASON = {
  github_installation_required: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because Kilo cannot access this repository with an active GitHub App installation. Update the GitHub App installation, then enable Code Reviewer again.',
    recoveryLabel: 'Update GitHub App',
    emailReason: 'Kilo cannot access this repository with an active GitHub App installation.',
    checkTitle: 'GitHub App access required',
    checkSummary:
      'Code Reviewer was disabled because Kilo cannot access this repository with an active GitHub App installation. Update the GitHub App installation, then enable Code Reviewer again.',
    gitlabDescription: 'GitHub App access required for Code Reviewer',
  },
  github_ip_allow_list: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because this GitHub organization uses an IP allow list that blocks Kilo. Contact hi@kilocode.ai to discuss supported access options, then enable Code Reviewer again.',
    recoveryLabel: 'Contact support',
    emailReason: 'This GitHub organization uses an IP allow list that blocks Kilo.',
    checkTitle: 'GitHub IP allow list blocks Kilo',
    checkSummary:
      'Code Reviewer was disabled because this GitHub organization uses an IP allow list that blocks Kilo. Contact hi@kilocode.ai, then enable Code Reviewer again.',
    gitlabDescription: 'GitHub IP allow list blocks Code Reviewer',
  },
  byok_invalid_key: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because the selected BYOK API key is invalid or has been revoked. Update the key or choose another model, then enable Code Reviewer again.',
    recoveryLabel: 'Update BYOK settings',
    emailReason: 'The selected BYOK API key is invalid or has been revoked.',
    checkTitle: 'BYOK API key needs attention',
    checkSummary:
      'Code Reviewer was disabled because the selected BYOK API key is invalid or has been revoked. Update the key or choose another model, then enable Code Reviewer again.',
    gitlabDescription: 'BYOK API key needs attention for Code Reviewer',
  },
  selected_model_unavailable: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because the selected model is not available for cloud agent sessions. Choose an available model, then enable Code Reviewer again.',
    recoveryLabel: 'Update Code Reviewer settings',
    emailReason: 'The selected model is not available for cloud agent sessions.',
    checkTitle: 'Selected model unavailable',
    checkSummary:
      'Code Reviewer was disabled because the selected model is not available for cloud agent sessions. Choose an available model, then enable Code Reviewer again.',
    gitlabDescription: 'Selected model unavailable for Code Reviewer',
  },
} satisfies Record<CodeReviewActionRequiredReason, CodeReviewActionRequiredCopy>;

const ACTION_REQUIRED_REASON_SET = new Set<string>(CODE_REVIEW_ACTION_REQUIRED_REASONS);

export function isCodeReviewActionRequiredReason(
  reason: string | null | undefined
): reason is CodeReviewActionRequiredReason {
  return reason !== null && reason !== undefined && ACTION_REQUIRED_REASON_SET.has(reason);
}

export function getCodeReviewActionRequiredCopy(
  reason: CodeReviewActionRequiredReason
): CodeReviewActionRequiredCopy {
  return COPY_BY_REASON[reason];
}

export function getCodeReviewActionRequiredRecoveryHref(
  reason: CodeReviewActionRequiredReason,
  organizationId?: string
): string {
  if (reason === 'github_installation_required') {
    return organizationId
      ? `/organizations/${organizationId}/integrations/github`
      : '/integrations/github';
  }

  if (reason === 'github_ip_allow_list') {
    return 'mailto:hi@kilocode.ai?subject=GitHub%20IP%20allow%20list%20for%20Code%20Reviewer';
  }

  if (reason === 'selected_model_unavailable') {
    return organizationId ? `/organizations/${organizationId}/code-reviews` : '/code-reviews';
  }

  return organizationId ? `/organizations/${organizationId}/byok` : '/byok';
}
