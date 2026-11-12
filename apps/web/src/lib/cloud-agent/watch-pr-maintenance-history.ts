import type { CliSessionV2, CloudAgentPrMaintenanceAttempt } from '@kilocode/db/schema';

export function maintenanceHistoryEntry(
  attempt: CloudAgentPrMaintenanceAttempt,
  session: Pick<CliSessionV2, 'total_cost_microdollars'> | null
) {
  const entry = {
    id: attempt.id,
    ordinal: attempt.ordinal,
    status: attempt.status,
    session_id: attempt.session_id,
    cloud_agent_session_id: attempt.cloud_agent_session_id,
    created_at: new Date(attempt.created_at).toISOString(),
    updated_at: new Date(attempt.updated_at).toISOString(),
    reason: attempt.reason,
    chatAvailable: session !== null,
    total_cost_microdollars: session?.total_cost_microdollars ?? null,
    triggerCount: attempt.input.problems.length,
    triggers: attempt.input.problems.slice(0, 50).map(problem => ({
      problemKey: problem.problemKey,
      kind: problem.kind,
      label: (problem.kind === 'review'
        ? problem.body
        : problem.kind === 'failed_check'
          ? problem.name
          : `Merge conflict with ${attempt.input.repository.baseRef}`
      ).slice(0, 500),
    })),
    result: attempt.result
      ? {
          summary: attempt.result.summary.slice(0, 2_000),
          changedFileCount: attempt.result.changedFiles.length,
          verificationCount: attempt.result.verification.length,
          changedFiles: attempt.result.changedFiles.slice(0, 50).map(path => path.slice(0, 300)),
          verification: attempt.result.verification.slice(0, 10).map(check => ({
            ...check,
            command: check.command.slice(0, 500),
            summary: check.summary.slice(0, 500),
            evidenceUrls: check.evidenceUrls.slice(0, 3),
          })),
          publication: attempt.result.publication,
          needsInput: attempt.result.needsInput?.slice(0, 1_000) ?? null,
        }
      : null,
  };
  const oversized = () => JSON.stringify(entry).length > 24_000;
  while (oversized() && entry.result && entry.result.changedFiles.length)
    entry.result.changedFiles.pop();
  while (oversized() && entry.result && entry.result.verification.length > 1)
    entry.result.verification.pop();
  while (oversized() && entry.triggers.length > 1) entry.triggers.pop();
  return entry;
}

export type WatchPrMaintenanceHistoryEntry = ReturnType<typeof maintenanceHistoryEntry>;
