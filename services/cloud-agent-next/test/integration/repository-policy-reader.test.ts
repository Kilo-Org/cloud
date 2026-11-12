import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRepositoryPolicyLookup } from '@kilocode/worker-utils/workspace-repository-access';
import { RepositoryPolicyReader } from '../../src/scm-broker/repository-policy-reader.js';

const ledger = vi.hoisted(() => ({ rows: [] as { sandboxId: string | null }[] }));
vi.mock('../../src/db/pg.js', () => ({
  getPgDb: () => ({
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => ledger.rows,
        }),
      }),
    }),
  }),
}));

const lookup: WorkspaceRepositoryPolicyLookup = {
  userId: 'oauth/owner',
  scopeId: 'worktree_policy',
  outboundContainerId: 'oc_current',
  owner: 'acme',
  name: 'repo',
  source: 'installation',
  installationId: '123',
  appType: 'standard',
  gitAuthor: { name: 'Kilo', email: 'bot@example.test' },
};
const policy = {
  sandboxId: 'sbx__current',
  access: { version: 1 as const, scopeId: lookup.scopeId, revision: 0, repositories: [] },
};

describe('repository policy compatibility ledger lookup', () => {
  beforeEach(() => {
    ledger.rows = [
      { sandboxId: 'sbx__retired' },
      { sandboxId: 'sbx__retired_again' },
      { sandboxId: 'sbx__current' },
    ];
  });
  function reader(read: ReturnType<typeof vi.fn>) {
    const getByName = vi.fn((_sandboxId: string) => ({ readWorkspaceRepositoryPolicy: read }));
    const service = new RepositoryPolicyReader(createExecutionContext(), {
      SANDBOX_CONTROL: { getByName },
    } as unknown as ConstructorParameters<typeof RepositoryPolicyReader>[1]);
    return { service, getByName };
  }
  it('asks the next canonical owner after multiple old ledger locations reject the binding', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(policy);
    const { service, getByName } = reader(read);
    await expect(service.readWorkspaceRepositoryPolicy(lookup)).resolves.toEqual(policy);
    expect(getByName.mock.calls.map(([id]) => id)).toEqual([
      'sbx__retired',
      'sbx__retired_again',
      'sbx__current',
    ]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenNthCalledWith(3, lookup);
  });
  it('fails closed when no canonical owner accepts the binding', async () => {
    const read = vi.fn().mockResolvedValue(null);
    const { service } = reader(read);
    await expect(service.readWorkspaceRepositoryPolicy(lookup)).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });
});
