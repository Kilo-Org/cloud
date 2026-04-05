import type { AutoTriageAgentConfig } from '@/lib/auto-triage/core/schemas';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * Result of configuration validation
 */
export type ValidationResult = { isValid: true } | { isValid: false; reason: string };

/**
 * Issue payload structure for validation
 */
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

/**
 * ConfigValidator
 *
 * Validates whether an issue should be processed based on agent configuration.
 * Checks repository allowlist and skip labels.
 */
export class ConfigValidator {
  /**
   * Validate if the issue should be processed based on configuration
   */
  validate(
    config: AutoTriageAgentConfig,
    payload: IssuePayloadForValidation,
    ownerType: 'org' | 'user',
    ownerId: string
  ): ValidationResult {
    // Check if enabled for issues
    if (!config.enabled_for_issues) {
      logExceptInTest(
        `Auto triage not enabled for issues for ${ownerType} ${ownerId} (repo: ${payload.repository.full_name})`
      );
      return { isValid: false, reason: 'Auto triage not enabled for issues' };
    }

    // Check repository allowlist
    if (!this.isRepositoryAllowed(config, payload.repository, ownerType, ownerId)) {
      return { isValid: false, reason: 'Repository not configured for auto triage' };
    }

    // Check skip labels
    if (this.hasSkipLabel(config, payload.issue, payload.repository.full_name)) {
      return { isValid: false, reason: 'Issue has skip label' };
    }

    // Check required labels
    if (!this.hasRequiredLabels(config, payload.issue, payload.repository.full_name)) {
      return { isValid: false, reason: 'Issue missing required labels' };
    }

    return { isValid: true };
  }

  /**
   * Check if repository is in allowed list (when using selected repositories mode)
   */
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

  /**
   * Check if issue has any skip labels
   */
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

  /**
   * Check if issue has all required labels
   */
  private hasRequiredLabels(
    config: AutoTriageAgentConfig,
    issue: { number: number; labels?: Array<string | { name: string }> },
    repoFullName: string
  ): boolean {
    // If no required labels are configured, validation passes
    if (!config.required_labels || config.required_labels.length === 0) {
      return true;
    }

    const issueLabels = issue.labels?.map(l => (typeof l === 'string' ? l : l.name)) || [];

    // Check if all required labels are present
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
