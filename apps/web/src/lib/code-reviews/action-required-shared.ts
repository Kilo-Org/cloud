import {
  CODE_REVIEW_ACTION_REQUIRED_REASONS,
  getCodeReviewActionRequiredCopy as getSharedCodeReviewActionRequiredCopy,
  type CodeReviewActionRequiredReason,
  type CodeReviewActionRequiredState,
} from '@kilocode/app-shared/code-reviews';

export {
  CODE_REVIEW_ACTION_REQUIRED_REASONS,
  type CodeReviewActionRequiredReason,
  type CodeReviewActionRequiredState,
};

export const CODE_REVIEW_ACTION_REQUIRED_RUNTIME_STATE_KEY = 'code_review_action_required';
export const CODE_REVIEW_SCOPED_ACTION_REQUIRED_RUNTIME_STATE_KEY =
  'code_review_scoped_action_required';

export type CodeReviewActionRequiredCopy = {
  title: string;
  description: string;
  recoveryLabel: string;
  emailReason: string;
  checkTitle: string;
  checkSummary: string;
  gitlabDescription: string;
};

// Web-only copy fields. The three user-facing strings (title, description,
// recovery label) live in @kilocode/app-shared/code-reviews; `emailReason` and
// `checkSummary` are derived from the shared description below, so the
// description text has exactly one source.
const WEB_COPY_BY_REASON: Record<
  CodeReviewActionRequiredReason,
  { checkTitle: string; gitlabDescription: string }
> = {
  github_installation_required: {
    checkTitle: 'Code Reviewer needs GitHub App access',
    gitlabDescription: 'Code Reviewer needs GitHub App access',
  },
  github_ip_allow_list: {
    checkTitle: 'Code Reviewer blocked by IP allow list',
    gitlabDescription: 'Code Reviewer blocked by GitHub IP allow list',
  },
  gitlab_project_access_required: {
    checkTitle: 'Code Reviewer needs GitLab token access',
    gitlabDescription: 'Code Reviewer needs GitLab token access',
  },
  byok_invalid_key: {
    checkTitle: 'Code Reviewer disabled: BYOK key issue',
    gitlabDescription: 'Code Reviewer disabled: BYOK key needs attention',
  },
  selected_model_unavailable: {
    checkTitle: 'Code Reviewer disabled: model unavailable',
    gitlabDescription: 'Code Reviewer disabled: selected model unavailable',
  },
  repeated_repository_clone_timeout: {
    checkTitle: 'Code Reviewer disabled: clone timeouts',
    gitlabDescription: 'Code Reviewer disabled: three repository clone timeouts today',
  },
};

const ACTION_REQUIRED_REASON_SET = new Set<string>(CODE_REVIEW_ACTION_REQUIRED_REASONS);

export function isCodeReviewActionRequiredReason(
  reason: string | null | undefined
): reason is CodeReviewActionRequiredReason {
  return reason !== null && reason !== undefined && ACTION_REQUIRED_REASON_SET.has(reason);
}

export function getCodeReviewActionRequiredCopy(
  reason: CodeReviewActionRequiredReason
): CodeReviewActionRequiredCopy {
  const shared = getSharedCodeReviewActionRequiredCopy(reason);
  const web = WEB_COPY_BY_REASON[reason];
  return {
    ...shared,
    emailReason: shared.description,
    checkSummary: shared.description,
    ...web,
  };
}

export function getCodeReviewActionRequiredRecoveryHref(
  reason: CodeReviewActionRequiredReason,
  organizationId?: string,
  platform?: 'github' | 'gitlab' | 'bitbucket',
  integrationId?: string
): string {
  if (reason === 'github_installation_required') {
    const path = organizationId
      ? `/organizations/${organizationId}/integrations/github`
      : '/integrations/github';
    return integrationId
      ? `${path}#github-installation-${encodeURIComponent(integrationId)}`
      : path;
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
    const basePath = organizationId
      ? `/organizations/${organizationId}/code-reviews`
      : '/code-reviews';
    return platform ? `${basePath}?platform=${platform}` : basePath;
  }

  return organizationId ? `/organizations/${organizationId}/byok` : '/byok';
}
