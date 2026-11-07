import {
  getBulkDestroyRetryIds,
  mergeBulkDestroyResults,
  type BulkDestroyResult,
} from './bulk-destroy-results';

function emptyResult(): BulkDestroyResult {
  return {
    destroyed: [],
    pending: [],
    skipped: [],
    failed: [],
    billing: { canceled: [], notNeeded: [], failed: [] },
  };
}

describe('bulk destruction results', () => {
  it('does not retry before a result exists', () => {
    expect(getBulkDestroyRetryIds(null)).toEqual([]);
  });

  it('retries both destruction and billing failures without duplicate instances', () => {
    const result = emptyResult();
    result.failed = [
      { instanceId: 'destroy-only', error: 'destroy failed' },
      { instanceId: 'both', error: 'destroy failed' },
    ];
    result.billing.failed = [
      { instanceId: 'billing-only', error: 'cancel failed' },
      { instanceId: 'both', error: 'cancel failed' },
    ];
    expect(getBulkDestroyRetryIds(result)).toEqual(['destroy-only', 'both', 'billing-only']);
  });

  it('uses the initial result without changing it', () => {
    const result = emptyResult();
    expect(mergeBulkDestroyResults(null, result, ['one'])).toBe(result);
  });

  it('retains unrelated results and replaces all outcomes for retried instances', () => {
    const previous = emptyResult();
    previous.destroyed = ['complete'];
    previous.failed = [
      { instanceId: 'retry-destroy', error: 'destroy failed' },
      { instanceId: 'retry-billing', error: 'billing_cancellation_failed' },
    ];
    previous.billing.canceled = [
      { instanceId: 'complete', subscriptionIds: ['sub-complete'] },
      { instanceId: 'retry-destroy', subscriptionIds: ['sub-canceled'] },
    ];
    previous.billing.failed = [{ instanceId: 'retry-billing', error: 'cancel failed' }];

    const next = emptyResult();
    next.destroyed = ['retry-destroy', 'retry-billing'];
    next.billing.canceled = [{ instanceId: 'retry-billing', subscriptionIds: ['sub-retried'] }];
    next.billing.notNeeded = ['retry-destroy'];

    const merged = mergeBulkDestroyResults(previous, next, ['retry-destroy', 'retry-billing']);
    expect(merged).toEqual({
      destroyed: ['complete', 'retry-destroy', 'retry-billing'],
      pending: [],
      skipped: [],
      failed: [],
      billing: {
        canceled: [
          { instanceId: 'complete', subscriptionIds: ['sub-complete'] },
          { instanceId: 'retry-billing', subscriptionIds: ['sub-retried'] },
        ],
        notNeeded: ['retry-destroy'],
        failed: [],
      },
    });
    expect(getBulkDestroyRetryIds(merged)).toEqual([]);
    expect(previous.failed).toHaveLength(2);
    expect(previous.billing.failed).toHaveLength(1);
  });

  it('keeps destruction blocked and retryable while billing cancellation fails', () => {
    const previous = emptyResult();
    previous.failed = [{ instanceId: 'one', error: 'billing_cancellation_failed' }];
    previous.billing.failed = [{ instanceId: 'one', error: 'provider unavailable' }];
    const next = emptyResult();
    next.failed = [{ instanceId: 'one', error: 'billing_cancellation_failed' }];
    next.billing.failed = [{ instanceId: 'one', error: 'database unavailable' }];

    const merged = mergeBulkDestroyResults(previous, next, ['one']);
    expect(merged.destroyed).toEqual([]);
    expect(merged.failed).toEqual(next.failed);
    expect(merged.billing.failed).toEqual(next.billing.failed);
    expect(getBulkDestroyRetryIds(merged)).toEqual(['one']);
  });

  it('includes pending provider cleanup in the remaining instances without duplicates', () => {
    const result = emptyResult();
    result.pending = ['pending', 'both'];
    result.failed = [{ instanceId: 'both', error: 'cleanup unavailable' }];
    expect(getBulkDestroyRetryIds(result)).toEqual(['both', 'pending']);
  });

  it('moves checked instances from pending to destroyed while retaining other pending results', () => {
    const previous = emptyResult();
    previous.pending = ['complete-next', 'still-pending'];
    const next = emptyResult();
    next.destroyed = ['complete-next'];
    const merged = mergeBulkDestroyResults(previous, next, ['complete-next']);
    expect(merged.destroyed).toEqual(['complete-next']);
    expect(merged.pending).toEqual(['still-pending']);
    expect(getBulkDestroyRetryIds(merged)).toEqual(['still-pending']);
    expect(previous.pending).toEqual(['complete-next', 'still-pending']);
  });
});
