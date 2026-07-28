import { reconcileStaleIntervals } from './postgres';

export const CONTAINER_USAGE_RECONCILIATION_CRON = '*/5 * * * *';

export async function runReconciliation(env: Cloudflare.Env): Promise<void> {
  const startedAt = Date.now();
  try {
    const reconciledIntervals = await reconcileStaleIntervals(env);
    console.log(
      JSON.stringify({
        message: 'Container usage reconciliation completed',
        event: 'container_usage_reconciliation',
        outcome: 'completed',
        reconciledIntervals,
        durationMs: Date.now() - startedAt,
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Container usage reconciliation failed',
        event: 'container_usage_reconciliation',
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
    );
    throw error;
  }
}
