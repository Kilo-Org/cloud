import {
  WORKSPACE_ARTIFACT_RETENTION_MS,
  type WorkspaceArtifactEntry,
} from '@kilocode/worker-utils/cloud-agent-workspace-artifacts';

export function getWorkspaceArtifactsQueryKey({
  userId,
  organizationId,
  cloudAgentSessionId,
}: {
  userId: string;
  organizationId?: string;
  cloudAgentSessionId: string;
}) {
  return ['workspace-artifacts', userId, organizationId ?? null, cloudAgentSessionId] as const;
}

export function workspaceArtifactExpiresAt(
  entry: Pick<WorkspaceArtifactEntry, 'updatedAt' | 'expiresAt'>
) {
  return entry.expiresAt ?? entry.updatedAt + WORKSPACE_ARTIFACT_RETENTION_MS;
}

export function groupWorkspaceArtifactsByFolder(entries: readonly WorkspaceArtifactEntry[]) {
  const groups = new Map<string, WorkspaceArtifactEntry[]>();
  for (const entry of entries) {
    const separator = entry.relativePath.lastIndexOf('/');
    const directory = separator === -1 ? '' : entry.relativePath.slice(0, separator);
    const existing = groups.get(directory);
    if (existing) existing.push(entry);
    else groups.set(directory, [entry]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([directory, files]) => ({
      directory,
      label: directory || 'Artifacts',
      files: [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    }));
}

export function workspaceArtifactFileName(entry: Pick<WorkspaceArtifactEntry, 'relativePath'>) {
  return entry.relativePath.slice(entry.relativePath.lastIndexOf('/') + 1);
}

const SANDBOX_NOT_RUNNING_STATUSES = new Set(['sleeping', 'stopping', 'error']);

export function isSandboxNotRunning(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && SANDBOX_NOT_RUNNING_STATUSES.has(status);
}

const sizeFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

export function formatWorkspaceArtifactSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = sizeBytes / 1_024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1_024; index += 1) {
    value /= 1_024;
    unit = units[index];
  }
  return `${sizeFormatter.format(value)} ${unit}`;
}
