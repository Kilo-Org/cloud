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
} from '@/components/ui/icons';

import {
  type AllowedMergeMethod,
  defaultMergeMethodFor,
  getAllowedMergeMethods,
  type MergeBlockedReasonId,
  prMergeLabel,
  type PrOverviewRepoSettings,
} from '@/lib/pr-review/merge/merge-blocked-reasons';

const BLOCKED_REASON_ICON = {
  conflicts: XCircle,
  'required-reviews': ShieldAlert,
  'failing-checks': AlertTriangle,
  behind: GitBranch,
  'unstable-checks': AlertTriangle,
  draft: GitPullRequest,
  'unknown-state': AlertTriangle,
} satisfies Record<MergeBlockedReasonId, LucideIcon>;

export function mergeBlockedReasonIcon(kind: MergeBlockedReasonId): LucideIcon {
  return BLOCKED_REASON_ICON[kind];
}

export type MergeMethodOption = {
  value: AllowedMergeMethod;
  label: string;
};

export function mergeMethodOptionsFor(repo: PrOverviewRepoSettings): MergeMethodOption[] {
  return getAllowedMergeMethods(repo).map(value => ({ value, label: prMergeLabel(value) }));
}

export function defaultMergeMethodOptionFor(repo: PrOverviewRepoSettings): AllowedMergeMethod {
  return defaultMergeMethodFor(repo);
}
