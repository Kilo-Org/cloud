import { z } from 'zod';
import { getTableFromZodSchema } from '../../util/table';

export const KiloClawInstanceStatus = z.enum(['provisioned', 'running', 'stopped', 'destroyed']);
export type KiloClawInstanceStatus = z.infer<typeof KiloClawInstanceStatus>;

export const KiloClawInstanceRecord = z.object({
  id: z.string(),
  user_id: z.string(),
  sandbox_id: z.string(),
  status: KiloClawInstanceStatus,
  created_at: z.string(),
  last_started_at: z.string().nullable(),
  last_stopped_at: z.string().nullable(),
  destroyed_at: z.string().nullable(),
});

export type KiloClawInstanceRecord = z.infer<typeof KiloClawInstanceRecord>;

export const kiloclaw_instances = getTableFromZodSchema(
  'kiloclaw_instances',
  KiloClawInstanceRecord
);
