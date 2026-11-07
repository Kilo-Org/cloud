import { destroyBulkTarget, type WorkerDestroyResponse } from './admin-bulk-destroy';

const finalized: WorkerDestroyResponse = {
  ok: true,
  finalized: true,
  destroyedUserId: 'user-1',
  destroyedSandboxId: 'ki_11111111111141118111111111111111',
  pendingMachineId: null,
  pendingVolumeId: null,
  lastDestroyErrorOp: null,
  lastDestroyErrorStatus: null,
  lastDestroyErrorAt: null,
};

function dependencies(overrides: Partial<Parameters<typeof destroyBulkTarget>[0]> = {}) {
  return {
    target: {
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'user-1',
      workerInstanceId: '11111111-1111-4111-8111-111111111111',
      destroyedAt: null,
    },
    cancelHosting: jest.fn().mockResolvedValue({ status: 'not_needed' }),
    markDestroyed: jest.fn().mockResolvedValue(true),
    restoreDestroyed: jest.fn().mockResolvedValue(undefined),
    destroyWorker: jest.fn().mockResolvedValue(finalized),
    isAlreadyGone: jest.fn().mockReturnValue(false),
    cleanup: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('destroyBulkTarget', () => {
  it('blocks destruction when hosting cancellation fails', async () => {
    const deps = dependencies({
      cancelHosting: jest.fn().mockResolvedValue({ status: 'failed', error: 'Stripe unavailable' }),
    });
    await expect(destroyBulkTarget(deps)).resolves.toEqual({
      billing: { status: 'failed', error: 'Stripe unavailable' },
      result: { status: 'failed', error: 'Stripe unavailable' },
    });
    expect(deps.destroyWorker).not.toHaveBeenCalled();
  });

  it('marks, destroys, and cleans up after no-op billing', async () => {
    const deps = dependencies();
    await expect(destroyBulkTarget(deps)).resolves.toEqual({
      billing: { status: 'not_needed' },
      result: { status: 'destroyed' },
    });
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
  });

  it('reports accepted partial provider finalization as pending', async () => {
    const deps = dependencies({
      destroyWorker: jest.fn().mockResolvedValue({
        ...finalized,
        finalized: false,
        pendingVolumeId: 'vol-1',
        lastDestroyErrorOp: 'volume',
      }),
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({ result: { status: 'pending' } });
    expect(deps.cleanup).not.toHaveBeenCalled();
  });

  it('restores the row when destroy throws after billing was canceled', async () => {
    const deps = dependencies({
      cancelHosting: jest
        .fn()
        .mockResolvedValue({ status: 'canceled', subscriptionIds: ['sub-1'] }),
      destroyWorker: jest.fn().mockRejectedValue(new Error('worker unavailable')),
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      billing: { status: 'canceled' },
      result: { status: 'failed', error: 'worker unavailable' },
    });
    expect(deps.restoreDestroyed).toHaveBeenCalledTimes(1);
  });

  it('retries cleanup for destroyed instance-keyed rows without remarking them', async () => {
    const deps = dependencies({
      target: {
        id: '11111111-1111-4111-8111-111111111111',
        userId: 'user-1',
        workerInstanceId: '11111111-1111-4111-8111-111111111111',
        destroyedAt: '2026-10-20T00:00:00.000Z',
      },
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      result: { status: 'skipped', reason: 'already_destroyed' },
    });
    expect(deps.markDestroyed).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not target a replacement legacy runtime during a destroyed-row retry', async () => {
    const deps = dependencies({
      target: {
        id: '11111111-1111-4111-8111-111111111111',
        userId: 'user-1',
        destroyedAt: '2026-10-20T00:00:00.000Z',
      },
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      result: { status: 'failed', error: 'legacy_destroy_retry_requires_manual_review' },
    });
    expect(deps.destroyWorker).not.toHaveBeenCalled();
  });

  it('does not mark or destroy when the billing operation throws', async () => {
    const deps = dependencies({
      cancelHosting: jest.fn().mockRejectedValue(new Error('billing database unavailable')),
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      billing: { status: 'failed', error: 'billing database unavailable' },
      result: { status: 'failed' },
    });
    expect(deps.markDestroyed).not.toHaveBeenCalled();
    expect(deps.destroyWorker).not.toHaveBeenCalled();
    expect(deps.cleanup).not.toHaveBeenCalled();
  });

  it('finishes billing before marking or destroying the selected instance', async () => {
    const order: string[] = [];
    const deps = dependencies({
      cancelHosting: jest.fn(async () => {
        await Promise.resolve();
        order.push('billing');
        return { status: 'canceled' as const, subscriptionIds: ['sub-1'] };
      }),
      markDestroyed: jest.fn(async () => {
        order.push('mark');
        return true;
      }),
      destroyWorker: jest.fn(async () => {
        order.push('destroy');
        return finalized;
      }),
      cleanup: jest.fn(async () => {
        order.push('cleanup');
      }),
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      result: { status: 'destroyed' },
    });
    expect(order).toEqual(['billing', 'mark', 'destroy', 'cleanup']);
  });

  it('surfaces post-destroy cleanup failure without pretending deletion can be rolled back', async () => {
    const deps = dependencies({
      cleanup: jest.fn().mockRejectedValue(new Error('email cleanup unavailable')),
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      result: { status: 'failed', error: 'email cleanup unavailable' },
    });
    expect(deps.restoreDestroyed).not.toHaveBeenCalled();
  });

  it('retries web cleanup when an instance-keyed DO has already finalized and wiped its state', async () => {
    const gone = new Error('Instance not provisioned');
    const deps = dependencies({
      target: {
        id: '11111111-1111-4111-8111-111111111111',
        userId: 'user-1',
        workerInstanceId: '11111111-1111-4111-8111-111111111111',
        destroyedAt: '2026-10-20T00:00:00.000Z',
      },
      destroyWorker: jest.fn().mockRejectedValue(gone),
      isAlreadyGone: jest.fn(error => error === gone),
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      result: { status: 'skipped', reason: 'already_destroyed' },
    });
    expect(deps.markDestroyed).not.toHaveBeenCalled();
    expect(deps.restoreDestroyed).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not infer resource deletion from an empty DO on a fresh active record', async () => {
    const deps = dependencies({
      destroyWorker: jest.fn().mockRejectedValue(new Error('Instance not provisioned')),
      isAlreadyGone: jest.fn().mockReturnValue(true),
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      result: { status: 'failed', error: 'Instance not provisioned' },
    });
    expect(deps.restoreDestroyed).toHaveBeenCalledTimes(1);
    expect(deps.cleanup).not.toHaveBeenCalled();
  });

  it('does not treat an arbitrary worker failure as finalized cleanup', async () => {
    const deps = dependencies({
      destroyWorker: jest.fn().mockRejectedValue(new Error('upstream route not found')),
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      result: { status: 'failed', error: 'upstream route not found' },
    });
    expect(deps.cleanup).not.toHaveBeenCalled();
    expect(deps.restoreDestroyed).toHaveBeenCalledTimes(1);
  });

  it.each([{ ok: true }, { ok: true, finalized: 'yes' }, { ok: false, finalized: true }])(
    'fails closed when the worker response does not confirm finalization: %j',
    response => {
      const deps = dependencies({ destroyWorker: jest.fn().mockResolvedValue(response) });
      return expect(destroyBulkTarget(deps)).resolves.toMatchObject({
        result: { status: 'failed', error: 'Worker did not confirm destruction state' },
      });
    }
  );

  it('reports rollback failure and preserves the original provider error', async () => {
    const deps = dependencies({
      destroyWorker: jest.fn().mockRejectedValue(new Error('worker unavailable')),
      restoreDestroyed: jest.fn().mockRejectedValue(new Error('database unavailable')),
    });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      result: {
        status: 'failed',
        error: 'worker unavailable; rollback failed: database unavailable',
      },
    });
    expect(deps.cleanup).not.toHaveBeenCalled();
  });

  it('does not call the worker if the active-instance marker changed concurrently', async () => {
    const deps = dependencies({ markDestroyed: jest.fn().mockResolvedValue(false) });
    await expect(destroyBulkTarget(deps)).resolves.toMatchObject({
      result: { status: 'failed', error: 'instance_destroy_state_changed' },
    });
    expect(deps.destroyWorker).not.toHaveBeenCalled();
    expect(deps.restoreDestroyed).not.toHaveBeenCalled();
  });
});
