// Shared Code Reviewer "action required" runtime state and its user-facing
// copy. The canonical source was apps/web/src/lib/code-reviews/action-required-shared.ts;
// this module holds the state type and the three strings the mobile overview
// banner renders (title, description, recovery label) so both apps read one
// source instead of duplicating them.

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
};

const COPY_BY_REASON: Record<CodeReviewActionRequiredReason, CodeReviewActionRequiredCopy> = {
  github_installation_required: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because Kilo cannot access this repository with an active GitHub App installation. Update the GitHub App installation, then enable Code Reviewer again.',
    recoveryLabel: 'Update GitHub App',
  },
  github_ip_allow_list: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because this GitHub organization uses an IP allow list that blocks Kilo. Contact hi@kilocode.ai for help, then enable Code Reviewer again.',
    recoveryLabel: 'Contact support',
  },
  gitlab_project_access_required: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because Kilo cannot create a GitLab Project Access Token for this project. Grant Maintainer access or enable Project Access Tokens, then enable Code Reviewer again.',
    recoveryLabel: 'Update GitLab integration',
  },
  byok_invalid_key: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because the selected BYOK API key is invalid, revoked, or lacks permission. Update the key or choose another model, then enable Code Reviewer again.',
    recoveryLabel: 'Update BYOK settings',
  },
  selected_model_unavailable: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled because the selected model is not available for cloud agent sessions. Choose an available model, then enable Code Reviewer again.',
    recoveryLabel: 'Update Code Reviewer settings',
  },
  repeated_repository_clone_timeout: {
    title: 'Code Reviewer needs attention',
    description:
      'Code Reviewer was disabled after three repository clone timeouts today. Contact hi@kilocode.ai for help, then enable Code Reviewer again.',
    recoveryLabel: 'Contact support',
  },
};

export function getCodeReviewActionRequiredCopy(
  reason: CodeReviewActionRequiredReason
): CodeReviewActionRequiredCopy {
  return COPY_BY_REASON[reason];
}
