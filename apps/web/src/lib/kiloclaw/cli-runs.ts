import { db } from '@/lib/drizzle';
import { kiloclaw_cli_runs } from '@kilocode/db/schema';
import type { KiloClawCliRunInitiatedBy } from '@kilocode/db/schema';

export interface CreateCliRunParams {
  userId: string;
  instanceId: string | null;
  prompt: string;
  startedAt: string;
  initiatedBy: KiloClawCliRunInitiatedBy;
}

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
