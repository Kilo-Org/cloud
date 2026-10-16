import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listAgents, type ListAgentsTarget } from '@kilocode/cloud-agent-sdk/list-agents';

import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

import { type CliAgent, useCliAgents } from './use-cli-agents';

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({}),
}));
vi.mock('@kilocode/cloud-agent-sdk/list-agents', () => ({
  listAgents: vi.fn(),
}));

type Probe = { current: CliAgent[] | null };

function Harness({ probe, target }: { probe: Probe; target: ListAgentsTarget | null }) {
  probe.current = useCliAgents(target);
  return null;
}

const listFn = vi.mocked(listAgents);

async function mount(target: ListAgentsTarget | null) {
  const probe: Probe = { current: null };
  await renderWithProviders(createElement(Harness, { probe, target }), {
    queryClient: createTestQueryClient(),
  });
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

    const agents = await mount({ connectionId: 'conn-1', directory: 'app' });

    await waitFor(() => (agents()?.length ?? 0) > 0);
    expect(agents()).toEqual([
      { slug: 'swift-vibecoder', name: 'swift-vibecoder', description: 'Builds Swift apps' },
      { slug: 'reviewer', name: 'Code Reviewer' },
    ]);
    expect(listFn).toHaveBeenCalledWith({}, { connectionId: 'conn-1', directory: 'app' });
  });

  it('reports no agents for a CLI that cannot list them', async () => {
    listFn.mockResolvedValue({ ok: false, reason: 'unsupported' });

    const agents = await mount({ connectionId: 'conn-1' });

    await waitFor(() => listFn.mock.calls.length === 1);
    expect(agents()).toEqual([]);
  });

  it('does not ask when there is no target', async () => {
    const agents = await mount(null);

    expect(agents()).toEqual([]);
    expect(listFn).not.toHaveBeenCalled();
  });
});
