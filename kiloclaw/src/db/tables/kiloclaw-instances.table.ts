import { z } from 'zod';
import { getTableFromZodSchema } from '../../util/table';

// Columns the worker reads from Postgres (via Hyperdrive).
// The Next.js backend is the sole writer.
const KiloClawInstanceColumns = z.object({
  id: z.string(),
  user_id: z.string(),
  sandbox_id: z.string(),
  channels: z.string().nullable(),
  vars: z.string().nullable(),
  destroyed_at: z.string().nullable(),
});

export const kiloclaw_instances = getTableFromZodSchema(
  'kiloclaw_instances',
  KiloClawInstanceColumns
);
