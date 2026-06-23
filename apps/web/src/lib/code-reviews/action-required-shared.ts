export const CODE_REVIEW_ACTION_REQUIRED_RUNTIME_STATE_KEY = 'code_review_action_required';

export const CODE_REVIEW_ACTION_REQUIRED_REASONS = [
  'github_installation_required',
  'github_ip_allow_list',
  'gitlab_project_access_required',
  'byok_invalid_key',
  'selected_model_unavailable',
  'repeated_repository_clone_timeout',
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
    emailReason:
      'Code Reviewer was disabled because Kilo cannot access this repository with an active GitHub App installation. Update the GitHub App installation, then enable Code Reviewer again.',
    checkTitle: 'Code Reviewer disabled: GitHub App access',
    checkSummary:
      'Code Reviewer was disabled because Kilo cannot access this repository with an active GitHub App installation. Update the GitHub App installation, then enable Code Reviewer again.',
    gitlabDescription: 'Code Reviewer disabled: GitHub App access required',
  },
  github_ip_allow_list: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because this GitHub organization uses an IP allow list that blocks Kilo. Contact hi@kilocode.ai for help, then enable Code Reviewer again.',
    recoveryLabel: 'Contact support',
    emailReason:
      'Code Reviewer was disabled because this GitHub organization uses an IP allow list that blocks Kilo. Contact hi@kilocode.ai for help, then enable Code Reviewer again.',
    checkTitle: 'Code Reviewer disabled: IP allow list',
    checkSummary:
      'Code Reviewer was disabled because this GitHub organization uses an IP allow list that blocks Kilo. Contact hi@kilocode.ai for help, then enable Code Reviewer again.',
    gitlabDescription: 'Code Reviewer disabled: GitHub IP allow list blocks Kilo',
  },
  gitlab_project_access_required: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because Kilo cannot create a GitLab Project Access Token for this project. Grant Maintainer access or enable Project Access Tokens, then enable Code Reviewer again.',
    recoveryLabel: 'Update GitLab integration',
    emailReason:
      'Code Reviewer was disabled because Kilo cannot create a GitLab Project Access Token for this project. Grant Maintainer access or enable Project Access Tokens, then enable Code Reviewer again.',
    checkTitle: 'Code Reviewer disabled: GitLab token setup',
    checkSummary:
      'Code Reviewer was disabled because Kilo cannot create a GitLab Project Access Token for this project. Grant Maintainer access or enable Project Access Tokens, then enable Code Reviewer again.',
    gitlabDescription: 'Code Reviewer disabled: GitLab token setup required',
  },
  byok_invalid_key: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because the selected BYOK API key is invalid, revoked, or lacks permission. Update the key or choose another model, then enable Code Reviewer again.',
    recoveryLabel: 'Update BYOK settings',
    emailReason:
      'Code Reviewer was disabled because the selected BYOK API key is invalid, revoked, or lacks permission. Update the key or choose another model, then enable Code Reviewer again.',
    checkTitle: 'Code Reviewer disabled: BYOK key issue',
    checkSummary:
      'Code Reviewer was disabled because the selected BYOK API key is invalid, revoked, or lacks permission. Update the key or choose another model, then enable Code Reviewer again.',
    gitlabDescription: 'Code Reviewer disabled: BYOK key needs attention',
  },
  selected_model_unavailable: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because the selected model is not available for cloud agent sessions. Choose an available model, then enable Code Reviewer again.',
    recoveryLabel: 'Update Code Reviewer settings',
    emailReason:
      'Code Reviewer was disabled because the selected model is not available for cloud agent sessions. Choose an available model, then enable Code Reviewer again.',
    checkTitle: 'Code Reviewer disabled: model unavailable',
    checkSummary:
      'Code Reviewer was disabled because the selected model is not available for cloud agent sessions. Choose an available model, then enable Code Reviewer again.',
    gitlabDescription: 'Code Reviewer disabled: selected model unavailable',
  },
  repeated_repository_clone_timeout: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled after three repository clone timeouts today. Contact hi@kilocode.ai for help, then enable Code Reviewer again.',
    recoveryLabel: 'Contact support',
    emailReason:
      'Code Reviewer was disabled after three repository clone timeouts today. Contact hi@kilocode.ai for help, then enable Code Reviewer again.',
    checkTitle: 'Code Reviewer disabled: clone timeouts',
    checkSummary:
      'Code Reviewer was disabled after three repository clone timeouts today. Contact hi@kilocode.ai for help, then enable Code Reviewer again.',
    gitlabDescription: 'Code Reviewer disabled: three repository clone timeouts today',
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

  if (reason === 'repeated_repository_clone_timeout') {
    return 'mailto:hi@kilocode.ai?subject=Repository%20clone%20timeouts%20for%20Code%20Reviewer';
  }

  if (reason === 'gitlab_project_access_required') {
    return organizationId
      ? `/organizations/${organizationId}/integrations/gitlab`
      : '/integrations/gitlab';
  }

  if (reason === 'selected_model_unavailable') {
    return organizationId ? `/organizations/${organizationId}/code-reviews` : '/code-reviews';
  }

  return organizationId ? `/organizations/${organizationId}/byok` : '/byok';
}
