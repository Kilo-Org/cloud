import { describe, expect, jest, test } from '@jest/globals';

import { runBestEffortPostCommitTasks } from './usage-post-commit-work';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error('deferred_not_initialized');
      resolvePromise();
    },
  };
}

describe('runBestEffortPostCommitTasks', () => {
  test('awaits personal Cost Insights transaction through commit and connection release', async () => {
    const transactionMayCommit = deferred();
    const events: string[] = [];
    const reportError = jest.fn((_error: unknown): void => {});

    const lifecycleWork = runBestEffortPostCommitTasks([
      {
        run: async () => {
          events.push('transaction-started');
          try {
            events.push('sql-completed');
            await transactionMayCommit.promise;
            events.push('committed');
          } finally {
            events.push('connection-released');
          }
        },
        reportError,
      },
    ]);

    await Promise.resolve();
    expect(events).toEqual(['transaction-started', 'sql-completed']);
    transactionMayCommit.resolve();
    await lifecycleWork;

    expect(events).toEqual([
      'transaction-started',
      'sql-completed',
      'committed',
      'connection-released',
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  test('awaits personal and organization work concurrently', async () => {
    const personalMayCommit = deferred();
    const organizationMayCommit = deferred();
    const completed: string[] = [];

    const lifecycleWork = runBestEffortPostCommitTasks([
      {
        run: async () => {
          await personalMayCommit.promise;
          completed.push('personal');
        },
        reportError: jest.fn((_error: unknown): void => {}),
      },
      {
        run: async () => {
          await organizationMayCommit.promise;
          completed.push('organization');
        },
        reportError: jest.fn((_error: unknown): void => {}),
      },
    ]);

    personalMayCommit.resolve();
    await Promise.resolve();
    expect(completed).toEqual(['personal']);

    organizationMayCommit.resolve();
    await lifecycleWork;
    expect(completed).toEqual(['personal', 'organization']);
  });

  test('reports rollback without rejecting lifecycle work or creating an unhandled rejection', async () => {
    const failure = new Error('transaction_failed');
    const reportError = jest.fn((_error: unknown): void => {});
    const unhandledRejection = jest.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      await expect(
        runBestEffortPostCommitTasks([
          {
            run: async () => {
              throw failure;
            },
            reportError,
          },
          {
            run: async () => {},
            reportError: jest.fn((_error: unknown): void => {}),
          },
        ])
      ).resolves.toBeUndefined();
      await new Promise(resolve => setImmediate(resolve));

      expect(reportError).toHaveBeenCalledWith(failure);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });

  test('awaits durable failure reporting before completing lifecycle work', async () => {
    const repairSignalMayCommit = deferred();
    const events: string[] = [];

    const lifecycleWork = runBestEffortPostCommitTasks([
      {
        run: async () => {
          throw new Error('transaction_failed');
        },
        reportError: async () => {
          events.push('repair-signal-started');
          await repairSignalMayCommit.promise;
          events.push('repair-signal-committed');
        },
      },
    ]);

    await Promise.resolve();
    expect(events).toEqual(['repair-signal-started']);

    repairSignalMayCommit.resolve();
    await lifecycleWork;
    expect(events).toEqual(['repair-signal-started', 'repair-signal-committed']);
  });
});
