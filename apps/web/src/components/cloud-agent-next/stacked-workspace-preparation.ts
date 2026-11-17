export type {
  StackedWorkspaceProviderInput,
  StackedWorkspaceSource,
} from '@/lib/cloud-agent/stacked-workspace-preparation';

export function stackedWorkspacePushReason(branch: string): string {
  return `Push \`${branch}\` first; it will be pushed after the next successful turn, or enable auto-commit`;
}
