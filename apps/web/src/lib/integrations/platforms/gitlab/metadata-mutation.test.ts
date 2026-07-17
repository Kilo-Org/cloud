import { describe, expect, it } from '@jest/globals';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { mutateGitLabMetadataInTransaction } from './metadata-mutation';

function createTransactionHarness(initialMetadata: Record<string, unknown>) {
  const store = { metadata: initialMetadata };
  let lockTail = Promise.resolve();

  async function transaction<T>(callback: (tx: DrizzleTransaction) => Promise<T>): Promise<T> {
    let releaseLock: (() => void) | undefined;
    const tx: DrizzleTransaction = Object.create(null);
    Object.assign(tx, {
      execute: async () => {
        const previousLock = lockTail;
        lockTail = new Promise<void>(resolve => {
          releaseLock = resolve;
        });
        await previousLock;
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ metadata: store.metadata }],
          }),
        }),
      }),
      update: () => ({
        set: ({ metadata }: { metadata: Record<string, unknown> }) => ({
          where: async () => {
            store.metadata = metadata;
          },
        }),
      }),
    });

    try {
      return await callback(tx);
    } finally {
      releaseLock?.();
    }
  }

  return { store, transaction };
}

describe('mutateGitLabMetadataInTransaction', () => {
  it('preserves unrelated fields across concurrent mutations', async () => {
    const { store, transaction } = createTransactionHarness({ auth_type: 'oauth' });

    await Promise.all([
      transaction(tx =>
        mutateGitLabMetadataInTransaction(tx, 'integration-1', {
          set: { webhook_secret: 'new-webhook-secret' },
        })
      ),
      transaction(tx =>
        mutateGitLabMetadataInTransaction(tx, 'integration-1', {
          set: { gitlab_instance_url: 'https://gitlab.example.com' },
        })
      ),
    ]);

    expect(store.metadata).toEqual({
      auth_type: 'oauth',
      webhook_secret: 'new-webhook-secret',
      gitlab_instance_url: 'https://gitlab.example.com',
    });
  });

  it('keeps an explicitly deleted secret absent during a later unrelated mutation', async () => {
    const { store, transaction } = createTransactionHarness({
      access_token: 'plaintext-secret',
      webhook_secret: 'old-webhook-secret',
    });

    await transaction(tx =>
      mutateGitLabMetadataInTransaction(tx, 'integration-1', {
        delete: ['access_token'],
      })
    );
    await transaction(tx =>
      mutateGitLabMetadataInTransaction(tx, 'integration-1', {
        set: { webhook_secret: 'new-webhook-secret' },
      })
    );

    expect(store.metadata).toEqual({ webhook_secret: 'new-webhook-secret' });
  });
});
