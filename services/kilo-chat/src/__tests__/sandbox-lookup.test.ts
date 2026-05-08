import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../services/sandbox-lookup');
vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

import { getWorkerDb } from '@kilocode/db/client';

import { clearSandboxLabelCache, fetchSandboxLabel } from '../services/sandbox-lookup';

type DbState = {
  queryCount: number;
  labels: Record<string, string>;
};

function installDbMock(state: DbState) {
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            state.queryCount++;
            return [{ name: state.labels[state.queryCount.toString()] ?? 'Sandbox' }];
          },
        }),
      }),
    }),
  };
  vi.mocked(getWorkerDb).mockReturnValue(fakeDb as unknown as ReturnType<typeof getWorkerDb>);
}

describe('fetchSandboxLabel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearSandboxLabelCache();
  });

  it('caches sandbox labels by sandbox id', async () => {
    const state: DbState = {
      queryCount: 0,
      labels: { '1': 'Cached Sandbox', '2': 'Other Sandbox' },
    };
    installDbMock(state);

    await expect(fetchSandboxLabel('postgres://test', 'sandbox-1')).resolves.toBe('Cached Sandbox');
    await expect(fetchSandboxLabel('postgres://test', 'sandbox-1')).resolves.toBe('Cached Sandbox');
    await expect(fetchSandboxLabel('postgres://test', 'sandbox-2')).resolves.toBe('Other Sandbox');

    expect(state.queryCount).toBe(2);
  });
});
