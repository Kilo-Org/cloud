import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { type SecurityAgentConfig } from '@/lib/security-agent';

// The settled settings card's copy lives here, beside its screen, so the
// screen file keeps under oxlint's file-length cap while the saved-config
// wiring stays on one page.

/** The disabled agent state's own line under the toggle. */
export function getDisabledCopy(canManage: boolean, hasEffectiveRepo: boolean): string {
  if (!canManage) {
    return i18n.t('securityAgent.settingsOverview.disabledNoManage');
  }
  if (!hasEffectiveRepo) {
    return i18n.t('securityAgent.settingsOverview.disabledNoRepo');
  }
  return i18n.t('securityAgent.settingsOverview.disabledPrompt');
}

/** The Repositories row's subtitle for a selection mode and its settled selection. */
export function repoCountCopy(args: {
  selectionMode: 'all' | 'selected';
  selectionCount: number;
  language: string;
  grantsSettledEmpty: boolean;
}): string {
  if (args.selectionMode === 'all') {
    // "All repositories" is a claim about the GitHub App grant, so a settled
    // empty grant must not make it: the repositories screen already answers
    // this state with its own no-repositories empty state, and the two
    // readings sit one tap apart.
    return args.grantsSettledEmpty
      ? i18n.t('securityAgent.repositories.noRepositories')
      : i18n.t('common.allRepositories');
  }
  return i18n.t('securityAgent.settingsOverview.repositoriesCount', {
    count: args.selectionCount,
    displayCount: formatNumber(args.selectionCount, args.language),
  });
}

/** The displaced settings rows' enabled counts, for the subtitles beside their titles. */
export function settingsEnabledCounts(data: SecurityAgentConfig) {
  return {
    automation: [
      data.autoAnalysisEnabled,
      data.autoRemediationEnabled,
      data.autoDismissEnabled,
    ].filter(Boolean).length,
    notifications: [data.newFindingNotificationsEnabled, data.slaNotificationsEnabled].filter(
      Boolean
    ).length,
  };
}
