import { db } from '@/lib/drizzle';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { kiloclaw_cli_runs } from '@kilocode/db/schema';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { resolveWorkerInstanceId } from '@/lib/kiloclaw/instance-registry';
import type { KiloCliRunStatusResponse } from '@/lib/kiloclaw/types';

export type CreateCliRunParams = {
  userId: string;
  instanceId: string | null;
  prompt: string;
  startedAt: string;
  initiatedByAdminId: string | null;
};

export function getCliRunInitiatedBy(params: {
  initiated_by_admin_id: string | null;
}): 'admin' | 'user' {
  return params.initiated_by_admin_id ? 'admin' : 'user';
}

export async function createCliRun(params: CreateCliRunParams): Promise<string> {
  const [row] = await db
    .insert(kiloclaw_cli_runs)
    .values({
      user_id: params.userId,
      instance_id: params.instanceId,
      initiated_by_admin_id: params.initiatedByAdminId,
      prompt: params.prompt,
      status: 'running',
      started_at: params.startedAt,
    })
    .returning({ id: kiloclaw_cli_runs.id });

  if (!row) {
    throw new Error('Failed to create CLI run');
  }

  return row.id;
}

export type PersistCliRunControllerStatusParams = {
  runId: string;
  userId: string;
  instanceId: string | null;
  controllerStatus: Pick<
    KiloCliRunStatusResponse,
    'status' | 'exitCode' | 'output' | 'completedAt'
  >;
};

export async function persistCliRunControllerStatus(
  params: PersistCliRunControllerStatusParams
): Promise<void> {
  await db
    .update(kiloclaw_cli_runs)
    .set({
      status: params.controllerStatus.status ?? 'failed',
      exit_code: params.controllerStatus.exitCode,
      output: params.controllerStatus.output,
      completed_at: params.controllerStatus.completedAt ?? new Date().toISOString(),
    })
    .where(
      and(
        eq(kiloclaw_cli_runs.id, params.runId),
        eq(kiloclaw_cli_runs.user_id, params.userId),
        eq(kiloclaw_cli_runs.status, 'running'),
        params.instanceId === null
          ? isNull(kiloclaw_cli_runs.instance_id)
          : eq(kiloclaw_cli_runs.instance_id, params.instanceId)
      )
    );
}

export type CancelCliRunParams = {
  runId: string;
  userId: string;
  instanceId: string | null;
};

export type CancelCliRunResult =
  | { ok: boolean; runFound: true; cancelled: boolean }
  | { ok: false; runFound: false; cancelled: false };

export type CliRunStatusResult = KiloCliRunStatusResponse & {
  prompt: string | null;
  initiatedBy: 'admin' | 'user' | null;
};

const LOST_CONTROLLER_RUN_OUTPUT =
  '[run state unavailable: controller no longer has an active CLI run for this record]';

const SUPERSEDED_CONTROLLER_RUN_OUTPUT =
  '[run state unavailable: controller has moved on to a newer run]';

export async function markCliRunCancelled(params: CancelCliRunParams): Promise<boolean> {
  const rows = await db
    .update(kiloclaw_cli_runs)
    .set({
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(kiloclaw_cli_runs.id, params.runId),
        eq(kiloclaw_cli_runs.user_id, params.userId),
        eq(kiloclaw_cli_runs.status, 'running'),
        params.instanceId === null
          ? isNull(kiloclaw_cli_runs.instance_id)
          : eq(kiloclaw_cli_runs.instance_id, params.instanceId)
      )
    )
    .returning({ id: kiloclaw_cli_runs.id });

  return rows.length > 0;
}

/**
 * Build WHERE conditions for discovering a CLI run row.
 *
 * When the caller has an active instance, the query is narrowed to that
 * instance. When instanceId is null (no active instance), the instance
 * filter is omitted so runs from destroyed instances can still be found.
 *
 * This is intentionally broader than the UPDATE helpers
 * ({@link markCliRunCancelled}, {@link persistCliRunControllerStatus}),
 * which always target the exact row via `row.instance_id`.
 */
function getCliRunScopeConditions(params: {
  runId: string;
  userId: string;
  instanceId: string | null;
}): SQL[] {
  const conditions: SQL[] = [
    eq(kiloclaw_cli_runs.id, params.runId),
    eq(kiloclaw_cli_runs.user_id, params.userId),
  ];

  if (params.instanceId !== null) {
    conditions.push(eq(kiloclaw_cli_runs.instance_id, params.instanceId));
  }

  return conditions;
}

export function getEmptyCliRunStatus(): CliRunStatusResult {
  return {
    hasRun: false,
    status: null,
    output: null,
    exitCode: null,
    startedAt: null,
    completedAt: null,
    prompt: null,
    initiatedBy: null,
  };
}

/**
 * Cancel a running CLI run, reconciling controller and DB state.
 *
 * Limitation: when the controller reports `hasRun: false`, the run's actual
 * terminal state is already evicted from controller memory. We record the row
 * as `'failed'` with a sentinel output, even though the run may have completed
 * successfully just before the cancel arrived. A re-poll cannot recover the
 * real outcome because the controller has already discarded it. This is a
 * strict improvement over leaving the row stuck in `'running'` forever, but
 * callers should be aware that a `'failed'` status with the
 * `LOST_CONTROLLER_RUN_OUTPUT` sentinel does not necessarily mean the run
 * actually failed — it means the outcome is unknown.
 */
export async function cancelCliRun(params: {
  runId: string;
  userId: string;
  instanceId: string | null;
  workerInstanceId?: string;
  getControllerStatus?: (
    userId: string,
    workerInstanceId: string | undefined
  ) => Promise<KiloCliRunStatusResponse>;
  cancelControllerRun?: (
    userId: string,
    workerInstanceId: string | undefined
  ) => Promise<{ ok: boolean }>;
}): Promise<CancelCliRunResult> {
  const [row] = await db
    .select()
    .from(kiloclaw_cli_runs)
    .where(and(...getCliRunScopeConditions(params)))
    .limit(1);

  if (!row) {
    return { ok: false, runFound: false, cancelled: false };
  }

  if (row.status !== 'running') {
    return { ok: true, runFound: true, cancelled: false };
  }

  const effectiveWorkerInstanceId =
    params.workerInstanceId ??
    (row.instance_id ? await resolveWorkerInstanceId(row.instance_id) : undefined);

  const client =
    params.getControllerStatus && params.cancelControllerRun
      ? undefined
      : new KiloClawInternalClient();
  const getControllerStatus =
    params.getControllerStatus ??
    ((userId: string, workerInstanceId: string | undefined) => {
      if (!client) throw new Error('KiloClaw internal client is not available');
      return client.getKiloCliRunStatus(userId, workerInstanceId);
    });
  const cancelControllerRun =
    params.cancelControllerRun ??
    (async (userId: string, workerInstanceId: string | undefined) => {
      if (!client) throw new Error('KiloClaw internal client is not available');
      try {
        return await client.cancelKiloCliRun(userId, workerInstanceId);
      } catch (err) {
        // The run finished between our status poll and the cancel request —
        // the controller rejects with 409. Translate to { ok: false } so the
        // caller can retry or poll for the terminal state.
        if (err instanceof KiloClawApiError && err.statusCode === 409) {
          return { ok: false };
        }
        throw err;
      }
    });

  const controllerStatus = await getControllerStatus(params.userId, effectiveWorkerInstanceId);
  if (!controllerStatus.hasRun) {
    await persistCliRunControllerStatus({
      runId: params.runId,
      userId: params.userId,
      instanceId: row.instance_id,
      controllerStatus: {
        status: 'failed',
        exitCode: row.exit_code,
        output: row.output ?? LOST_CONTROLLER_RUN_OUTPUT,
        completedAt: new Date().toISOString(),
      },
    });
    return { ok: true, runFound: true, cancelled: false };
  }

  if (!isControllerStatusForRun(row, controllerStatus)) {
    // Controller has moved on — persist 'failed' so the row doesn't stay
    // 'running' forever, then report not-cancelled (there's nothing to cancel).
    await persistCliRunControllerStatus({
      runId: params.runId,
      userId: params.userId,
      instanceId: row.instance_id,
      controllerStatus: {
        status: 'failed',
        exitCode: row.exit_code,
        output: row.output ?? SUPERSEDED_CONTROLLER_RUN_OUTPUT,
        completedAt: new Date().toISOString(),
      },
    });
    return { ok: true, runFound: true, cancelled: false };
  }

  // The controller already reached a terminal state for this run — persist it
  // instead of issuing a cancel that the controller would reject.
  if (controllerStatus.status !== 'running') {
    await persistCliRunControllerStatus({
      runId: params.runId,
      userId: params.userId,
      instanceId: row.instance_id,
      controllerStatus,
    });
    return { ok: true, runFound: true, cancelled: false };
  }

  const result = await cancelControllerRun(params.userId, effectiveWorkerInstanceId);

  if (!result.ok) {
    // The controller rejected the cancel (e.g. the process had already exited
    // between our DB check and the cancel request). The DB row intentionally
    // stays 'running' so the caller can retry or poll again — the next
    // getKiloCliRunStatus call will pick up the terminal state from the
    // controller and persist it.
    return { ok: false, runFound: true, cancelled: false };
  }

  const didUpdate = await markCliRunCancelled({
    runId: params.runId,
    userId: params.userId,
    instanceId: row.instance_id,
  });

  // didUpdate is false when the row left 'running' between our SELECT and
  // this UPDATE (e.g. a concurrent getCliRunStatus poll persisted a terminal
  // state, or another cancel request won the race).
  return { ok: true, runFound: true, cancelled: didUpdate };
}

/**
 * Poll the status of a CLI run, reconciling controller and DB state.
 *
 * Limitation: when the controller reports `hasRun: false`, the run's actual
 * terminal state is already evicted from controller memory. We record the row
 * as `'failed'` with a sentinel output, even though the run may have completed
 * successfully. See {@link cancelCliRun} for the same limitation and rationale.
 */
export async function getCliRunStatus(params: {
  runId: string;
  userId: string;
  instanceId: string | null;
  workerInstanceId?: string;
  getControllerStatus?: (
    userId: string,
    workerInstanceId: string | undefined
  ) => Promise<KiloCliRunStatusResponse>;
}): Promise<CliRunStatusResult> {
  const [row] = await db
    .select()
    .from(kiloclaw_cli_runs)
    .where(and(...getCliRunScopeConditions(params)))
    .limit(1);

  if (!row) {
    return getEmptyCliRunStatus();
  }

  if (row.status !== 'running') {
    return {
      hasRun: true,
      status: row.status,
      output: row.output,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? null,
      prompt: row.prompt,
      initiatedBy: getCliRunInitiatedBy(row),
    };
  }

  const effectiveWorkerInstanceId =
    params.workerInstanceId ??
    (row.instance_id ? await resolveWorkerInstanceId(row.instance_id) : undefined);

  const getControllerStatus =
    params.getControllerStatus ??
    ((userId: string, workerInstanceId: string | undefined) => {
      const client = new KiloClawInternalClient();
      return client.getKiloCliRunStatus(userId, workerInstanceId);
    });
  const controllerStatus = await getControllerStatus(params.userId, effectiveWorkerInstanceId);

  if (!controllerStatus.hasRun) {
    const completedAt = new Date().toISOString();
    const output = row.output ?? LOST_CONTROLLER_RUN_OUTPUT;
    await persistCliRunControllerStatus({
      runId: params.runId,
      userId: params.userId,
      instanceId: row.instance_id,
      controllerStatus: {
        status: 'failed',
        exitCode: row.exit_code,
        output,
        completedAt,
      },
    });

    return {
      hasRun: true,
      status: 'failed',
      output,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      completedAt,
      prompt: row.prompt,
      initiatedBy: getCliRunInitiatedBy(row),
    };
  }

  if (!isControllerStatusForRun(row, controllerStatus)) {
    // The controller has a run but with a different startedAt — it has moved
    // on to a newer CLI run and will never report a terminal state for our
    // row. Persist 'failed' so the row doesn't stay 'running' forever.
    const completedAt = new Date().toISOString();
    const output = row.output ?? SUPERSEDED_CONTROLLER_RUN_OUTPUT;
    await persistCliRunControllerStatus({
      runId: params.runId,
      userId: params.userId,
      instanceId: row.instance_id,
      controllerStatus: {
        status: 'failed',
        exitCode: row.exit_code,
        output,
        completedAt,
      },
    });

    return {
      hasRun: true,
      status: 'failed',
      output,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      completedAt,
      prompt: row.prompt,
      initiatedBy: getCliRunInitiatedBy(row),
    };
  }

  if (shouldPersistCliRunControllerStatus(row, controllerStatus)) {
    await persistCliRunControllerStatus({
      runId: params.runId,
      userId: params.userId,
      instanceId: row.instance_id,
      controllerStatus,
    });
  }

  return {
    ...controllerStatus,
    prompt: row.prompt,
    initiatedBy: getCliRunInitiatedBy(row),
  };
}

export function isControllerStatusForRun(
  row: { started_at: string | null },
  controllerStatus: Pick<KiloCliRunStatusResponse, 'hasRun' | 'startedAt'>
): boolean {
  if (!controllerStatus.hasRun) {
    return false;
  }

  const controllerStartedAtMs = controllerStatus.startedAt
    ? Date.parse(controllerStatus.startedAt)
    : Number.NaN;
  const rowStartedAtMs = row.started_at ? Date.parse(row.started_at) : Number.NaN;

  return (
    Number.isFinite(controllerStartedAtMs) &&
    Number.isFinite(rowStartedAtMs) &&
    controllerStartedAtMs === rowStartedAtMs
  );
}

export function shouldPersistCliRunControllerStatus(
  row: { started_at: string | null },
  controllerStatus: Pick<KiloCliRunStatusResponse, 'hasRun' | 'status' | 'startedAt'>
): boolean {
  if (controllerStatus.status === 'running') {
    return false;
  }

  return isControllerStatusForRun(row, controllerStatus);
}
