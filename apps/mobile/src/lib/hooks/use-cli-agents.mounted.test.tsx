import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listAgents, type ListAgentsTarget } from '@kilocode/cloud-agent-sdk/list-agents';

import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

import { type CliAgents, useCliAgents } from './use-cli-agents';

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({}),
}));
vi.mock('@kilocode/cloud-agent-sdk/list-agents', () => ({
  listAgents: vi.fn(),
}));

type Probe = { current: CliAgents | null };

function Harness({ probe, target }: { probe: Probe; target: ListAgentsTarget | null }) {
  probe.current = useCliAgents(target);
  return null;
}

const listFn = vi.mocked(listAgents);

let client = createTestQueryClient();

async function mount(target: ListAgentsTarget | null) {
  client = createTestQueryClient();
  client.setQueryDefaults(['cli-agents'], { retryDelay: 0 });
  const probe: Probe = { current: null };
  await renderWithProviders(createElement(Harness, { probe, target }), { queryClient: client });
  return () => probe.current;
}

describe('useCliAgents', () => {
  beforeEach(() => {
    listFn.mockReset();
  });

  it('maps reported agents to picker agents, preferring the display name', async () => {
    listFn.mockResolvedValue({
      ok: true,
      agents: [
        { name: 'swift-vibecoder', description: 'Builds Swift apps' },
        { name: 'reviewer', displayName: 'Code Reviewer' },
      ],
    });

    const hook = await mount({ connectionId: 'conn-1', directory: 'app' });

    await waitFor(() => hook()?.settled === true);
    expect(hook()?.agents).toEqual([
      { slug: 'swift-vibecoder', name: 'swift-vibecoder', description: 'Builds Swift apps' },
      { slug: 'reviewer', name: 'Code Reviewer' },
    ]);
    expect(listFn).toHaveBeenCalledWith({}, { connectionId: 'conn-1', directory: 'app' });
  });

  it('stays unsettled with no agents for a CLI that cannot list them', async () => {
    listFn.mockResolvedValue({ ok: false, reason: 'unsupported' });
    const target = { connectionId: 'conn-1' };

    const hook = await mount(target);

    await waitFor(() => client.getQueryState(['cli-agents', target])?.status === 'success');
    expect(hook()).toEqual({ agents: [], settled: false });
  });

  it('stays unsettled when the CLI cannot be reached after the retry', async () => {
    listFn.mockResolvedValue({ ok: false, reason: 'transport', cause: new Error('offline') });

    const hook = await mount({ connectionId: 'conn-1' });

    await waitFor(() => listFn.mock.calls.length === 2);
    expect(hook()).toEqual({ agents: [], settled: false });
  });

  it('is settled with no agents and does not ask when there is no target', async () => {
    const hook = await mount(null);

    expect(hook()).toEqual({ agents: [], settled: true });
    expect(listFn).not.toHaveBeenCalled();
  });
});
