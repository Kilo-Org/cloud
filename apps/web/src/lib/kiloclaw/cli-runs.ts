import { db } from '@/lib/drizzle';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { kiloclaw_cli_runs } from '@kilocode/db/schema';
import type { KiloClawCliRunInitiatedBy } from '@kilocode/db/schema';
import type { KiloCliRunStatusResponse } from '@/lib/kiloclaw/types';

export type CreateCliRunParams = {
  userId: string;
  instanceId: string | null;
  prompt: string;
  startedAt: string;
  initiatedBy: KiloClawCliRunInitiatedBy;
};

export async function createCliRun(params: CreateCliRunParams): Promise<string> {
  const [row] = await db
    .insert(kiloclaw_cli_runs)
    .values({
      user_id: params.userId,
      instance_id: params.instanceId,
      prompt: params.prompt,
      status: 'running',
      started_at: params.startedAt,
      initiated_by: params.initiatedBy,
    })
    .returning({ id: kiloclaw_cli_runs.id });

  return row.id;
}

export type CancelCliRunParams = {
  runId: string;
  userId: string;
  instanceId?: string | null;
  initiatedBy?: KiloClawCliRunInitiatedBy;
};

export async function markCliRunCancelled(params: CancelCliRunParams): Promise<void> {
  const conditions: SQL[] = [
    eq(kiloclaw_cli_runs.id, params.runId),
    eq(kiloclaw_cli_runs.user_id, params.userId),
    eq(kiloclaw_cli_runs.status, 'running'),
  ];

  if (params.instanceId !== undefined) {
    conditions.push(
      params.instanceId === null
        ? isNull(kiloclaw_cli_runs.instance_id)
        : eq(kiloclaw_cli_runs.instance_id, params.instanceId)
    );
  }

  if (params.initiatedBy) {
    conditions.push(eq(kiloclaw_cli_runs.initiated_by, params.initiatedBy));
  }

  await db
    .update(kiloclaw_cli_runs)
    .set({
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    })
    .where(and(...conditions));
}

export function shouldPersistCliRunControllerStatus(
  row: { started_at: string | null },
  controllerStatus: Pick<KiloCliRunStatusResponse, 'hasRun' | 'status' | 'startedAt'>
): boolean {
  if (!controllerStatus.hasRun || controllerStatus.status === 'running') {
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
