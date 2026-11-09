import type { CloudStatus, PreparationAttempt } from '@kilocode/cloud-agent-sdk';

const ENVIRONMENT_SNAPSHOT_STEP_KEY = 'environment_snapshot';

/**
 * The environment whose build the user should open after a failed start. A
 * session whose environment has build commands starts only from that
 * environment's snapshot; when the snapshot is missing, still building, failed
 * or cannot start, preparation fails at the environment snapshot step. Returns
 * the environment id when the latest attempt failed there.
 */
export function environmentBuildRecoveryOffered(input: {
  cloudStatus: Pick<CloudStatus, 'type'> | null | undefined;
  attempts: readonly PreparationAttempt[];
  environmentId: string | null | undefined;
}): string | null {
  if (input.cloudStatus?.type !== 'error' || !input.environmentId) return null;
  const latest = input.attempts.reduce<PreparationAttempt | undefined>(
    (current, attempt) =>
      current === undefined || attempt.startedAt >= current.startedAt ? attempt : current,
    undefined
  );
  if (latest?.status !== 'failed') return null;
  const lastPhase = latest.steps.findLast(step => step.kind === 'phase');
  return lastPhase?.key === ENVIRONMENT_SNAPSHOT_STEP_KEY ? input.environmentId : null;
}
