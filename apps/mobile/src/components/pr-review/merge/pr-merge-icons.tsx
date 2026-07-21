// Icon-map for the S8 merge surfaces. Lives here (not in the pure
// selector) so the selector's tests can load in plain Node without
// pulling in lucide-react-native.

import {
  AlertTriangle,
  GitBranch,
  GitPullRequest,
  type LucideIcon,
  ShieldAlert,
  XCircle,
} from 'lucide-react-native';

import {
  type AllowedMergeMethod,
  defaultMergeMethodFor,
  getAllowedMergeMethods,
  type MergeBlockedReasonId,
  PR_MERGE_LABELS,
  type PrOverviewRepoSettings,
} from '@/lib/pr-review/merge/merge-blocked-reasons';

const BLOCKED_REASON_ICON: Record<MergeBlockedReasonId, LucideIcon> = {
  conflicts: XCircle,
  'required-reviews': ShieldAlert,
  'failing-checks': AlertTriangle,
  behind: GitBranch,
  'unstable-checks': AlertTriangle,
  draft: GitPullRequest,
  'unknown-state': AlertTriangle,
};

export function mergeBlockedReasonIcon(kind: MergeBlockedReasonId): LucideIcon {
  return BLOCKED_REASON_ICON[kind];
}

export type MergeMethodOption = {
  value: AllowedMergeMethod;
  label: string;
};

export function mergeMethodOptionsFor(repo: PrOverviewRepoSettings): MergeMethodOption[] {
  return getAllowedMergeMethods(repo).map(value => ({ value, label: PR_MERGE_LABELS[value] }));
}

export function defaultMergeMethodOptionFor(repo: PrOverviewRepoSettings): AllowedMergeMethod {
  return defaultMergeMethodFor(repo);
}
