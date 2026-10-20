import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

export type BulkDestroyResult =
  inferRouterOutputs<RootRouter>['admin']['kiloclawInstances']['bulkDestroy'];

export function getBulkDestroyRetryIds(result: BulkDestroyResult | null): string[] {
  if (!result) return [];
  return [
    ...new Set([
      ...result.failed.map(item => item.instanceId),
      ...result.billing.failed.map(item => item.instanceId),
      ...result.pending,
    ]),
  ];
}

export function mergeBulkDestroyResults(
  previous: BulkDestroyResult | null,
  next: BulkDestroyResult,
  instanceIds: string[]
): BulkDestroyResult {
  if (!previous) return next;
  const retried = new Set(instanceIds);
  const keepIds = (ids: string[]) => ids.filter(id => !retried.has(id));
  const keepRows = <T extends { instanceId: string }>(rows: T[]) =>
    rows.filter(row => !retried.has(row.instanceId));

  return {
    destroyed: [...keepIds(previous.destroyed), ...next.destroyed],
    pending: [...keepIds(previous.pending), ...next.pending],
    skipped: [...keepRows(previous.skipped), ...next.skipped],
    failed: [...keepRows(previous.failed), ...next.failed],
    billing: {
      canceled: [...keepRows(previous.billing.canceled), ...next.billing.canceled],
      notNeeded: [...keepIds(previous.billing.notNeeded), ...next.billing.notNeeded],
      failed: [...keepRows(previous.billing.failed), ...next.billing.failed],
    },
  };
}
