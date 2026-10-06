import type { AutoTriageAgentConfig } from '@/lib/auto-triage/core/schemas';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

export type ValidationResult = { isValid: true } | { isValid: false; reason: string };

export type IssuePayloadForValidation = {
  issue: {
    number: number;
    labels?: Array<string | { name: string }>;
  };
  repository: {
    id: number;
    full_name: string;
  };
};

export class ConfigValidator {
  validate(
    config: AutoTriageAgentConfig,
    payload: IssuePayloadForValidation,
    ownerType: 'org' | 'user',
    ownerId: string
  ): ValidationResult {
    if (!config.enabled_for_issues) {
      logExceptInTest(
        `Auto triage not enabled for issues for ${ownerType} ${ownerId} (repo: ${payload.repository.full_name})`
      );
      return { isValid: false, reason: 'Auto triage not enabled for issues' };
    }

    if (!this.isRepositoryAllowed(config, payload.repository, ownerType, ownerId)) {
      return { isValid: false, reason: 'Repository not configured for auto triage' };
    }

    if (this.hasSkipLabel(config, payload.issue, payload.repository.full_name)) {
      return { isValid: false, reason: 'Issue has skip label' };
    }

    if (!this.hasRequiredLabels(config, payload.issue, payload.repository.full_name)) {
      return { isValid: false, reason: 'Issue missing required labels' };
    }

    return { isValid: true };
  }

  private isRepositoryAllowed(
    config: AutoTriageAgentConfig,
    repository: { id: number; full_name: string },
    ownerType: 'org' | 'user',
    ownerId: string
  ): boolean {
    if (
      config.repository_selection_mode === 'selected' &&
      Array.isArray(config.selected_repository_ids)
    ) {
      const isAllowed = config.selected_repository_ids.includes(repository.id);

      if (!isAllowed) {
        logExceptInTest(
          `Repository ${repository.full_name} (ID: ${repository.id}) not in allowed list for ${ownerType} ${ownerId}`
        );
        return false;
      }

      logExceptInTest(
        `Repository ${repository.full_name} (ID: ${repository.id}) is in allowed list, proceeding with triage`
      );
    }

    return true;
  }

  private hasSkipLabel(
    config: AutoTriageAgentConfig,
    issue: { number: number; labels?: Array<string | { name: string }> },
    repoFullName: string
  ): boolean {
    const issueLabels = issue.labels?.map(l => (typeof l === 'string' ? l : l.name)) || [];

    if (config.skip_labels?.some(label => issueLabels.includes(label))) {
      logExceptInTest(`Issue ${repoFullName}#${issue.number} has skip label, skipping triage`);
      return true;
    }

    return false;
  }

  private hasRequiredLabels(
    config: AutoTriageAgentConfig,
    issue: { number: number; labels?: Array<string | { name: string }> },
    repoFullName: string
  ): boolean {
    if (!config.required_labels || config.required_labels.length === 0) {
      return true;
    }

    const issueLabels = issue.labels?.map(l => (typeof l === 'string' ? l : l.name)) || [];

    const missingLabels = config.required_labels.filter(label => !issueLabels.includes(label));

    if (missingLabels.length > 0) {
      logExceptInTest(
        `Issue ${repoFullName}#${issue.number} missing required labels: ${missingLabels.join(', ')}, skipping triage`
      );
      return false;
    }

    return true;
  }
}
