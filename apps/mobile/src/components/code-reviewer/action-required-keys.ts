import { type CodeReviewActionRequiredReason } from '@kilocode/app-shared/code-reviews';

// Catalog keys for the needs-attention banner. packages/app-shared keeps its
// English for web; mobile renders the translated copy for the same reason code.
export const ACTION_REQUIRED_KEYS = {
  github_installation_required: {
    title:
      // i18n-dup-ok: 'codeReviewer.actionRequired.title' — sole key for this copy; the base-catalog twin this scan cites was removed by the catalog consolidation
      'codeReviewer.actionRequired.title',
    description: 'codeReviewer.actionRequired.githubInstallationRequired.description',
    recoveryLabel: 'codeReviewer.actionRequired.githubInstallationRequired.recoveryLabel',
  },
  github_ip_allow_list: {
    title: 'codeReviewer.actionRequired.title',
    description: 'codeReviewer.actionRequired.githubIpAllowList.description',
    recoveryLabel:
      // i18n-dup-ok: 'codeReviewer.actionRequired.recoveryLabel' — sole key for this copy; the base-catalog twin this scan cites was removed by the catalog consolidation
      'codeReviewer.actionRequired.recoveryLabel',
  },
  gitlab_project_access_required: {
    title: 'codeReviewer.actionRequired.title',
    description: 'codeReviewer.actionRequired.gitlabProjectAccessRequired.description',
    recoveryLabel: 'codeReviewer.actionRequired.gitlabProjectAccessRequired.recoveryLabel',
  },
  byok_invalid_key: {
    title: 'codeReviewer.actionRequired.title',
    description: 'codeReviewer.actionRequired.byokInvalidKey.description',
    recoveryLabel: 'codeReviewer.actionRequired.byokInvalidKey.recoveryLabel',
  },
  selected_model_unavailable: {
    title: 'codeReviewer.actionRequired.title',
    description: 'codeReviewer.actionRequired.selectedModelUnavailable.description',
    recoveryLabel: 'codeReviewer.actionRequired.selectedModelUnavailable.recoveryLabel',
  },
  repeated_repository_clone_timeout: {
    title: 'codeReviewer.actionRequired.title',
    description: 'codeReviewer.actionRequired.repeatedRepositoryCloneTimeout.description',
    recoveryLabel: 'codeReviewer.actionRequired.recoveryLabel',
  },
} satisfies Record<
  CodeReviewActionRequiredReason,
  { title: string; description: string; recoveryLabel: string }
>;
