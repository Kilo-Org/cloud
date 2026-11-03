import { sql, type SQLWrapper } from 'drizzle-orm';

export function noLiveBenchmarkChunks(entry: {
  router: string | SQLWrapper;
  model: string | SQLWrapper;
  variant: string | SQLWrapper;
  engineIdentity: string | SQLWrapper;
  repetitions: number | SQLWrapper;
}) {
  return sql`NOT EXISTS (
    SELECT 1 FROM scheduler_chunks AS live_chunk
    JOIN benchmark_runs AS live_run ON live_run.id = live_chunk.run_id
    WHERE live_run.router = ${entry.router}
      AND live_run.kind = 'decider'
      AND live_run.engine_identity = ${entry.engineIdentity}
      AND live_run.repetitions = ${entry.repetitions}
      AND live_chunk.model = ${entry.model}
      AND live_chunk.variant = ${entry.variant}
      AND live_chunk.status IN ('queued', 'active')
  )`;
}
