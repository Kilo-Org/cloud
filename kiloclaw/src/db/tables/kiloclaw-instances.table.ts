import { z } from 'zod';
import { getTableFromZodSchema } from '../../util/table';

// Only columns referenced by InstanceStore SQL queries.
// The actual DB table has more columns (created_at, last_started_at, etc.)
// but they aren't read or written by the worker.
const KiloClawInstanceColumns = z.object({
  id: z.string(),
  user_id: z.string(),
  sandbox_id: z.string(),
  status: z.string(),
  destroyed_at: z.string().nullable(),
});

export const kiloclaw_instances = getTableFromZodSchema(
  'kiloclaw_instances',
  KiloClawInstanceColumns
);
