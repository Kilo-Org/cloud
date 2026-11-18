import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type InstanceModelCatalogResult,
  listInstanceModels,
  type RemoteModelCatalogV1,
} from '@kilocode/cloud-agent-sdk/instance-model-catalog';

import { createKiloAppQueryClient } from '@/lib/query-client';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { useInstanceModelCatalog } from './use-instance-model-catalog';

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({}),
}));
vi.mock('@kilocode/cloud-agent-sdk/instance-model-catalog', () => ({
  listInstanceModels: vi.fn(),
}));

type Probe = { current: { catalog: RemoteModelCatalogV1 | null; isLoading: boolean } | null };

function Harness({ probe }: { probe: Probe }) {
  probe.current = useInstanceModelCatalog('conn-1');
  return null;
}

const listFn = vi.mocked(listInstanceModels);

const catalog: InstanceModelCatalogResult = {
  ok: true,
  catalog: {
    protocolVersion: 1,
    providers: [
      {
        id: 'kilo',
        models: [
          {
            id: 'kilo/auto',
            variants: [],
            capabilities: { attachment: false, reasoning: false },
            limits: { context: 1000, output: 1000 },
          },
        ],
      },
    ],
    truncated: false,
  },
};

let events: TelemetryEvent[] = [];
let client = createKiloAppQueryClient();

/**
 * Mount the hook on the app's real query client, so the app-wide
 * `QueryCache.onError` reporting runs. Only the retry delay is removed.
 */
async function mount() {
  client = createKiloAppQueryClient();
  client.setQueryDefaults(['instance-model-catalog'], { retryDelay: 0 });
  const probe: Probe = { current: null };
  const rendered = await renderWithProviders(createElement(Harness, { probe }), {
    queryClient: client,
  });
  return { ...rendered, hook: () => probe.current };
}

describe('useInstanceModelCatalog error reporting', () => {
  beforeEach(() => {
    listFn.mockReset();
    events = [];
    setTelemetrySink(event => {
      events.push(event);
    });
  });

  afterEach(() => {
    setTelemetrySink(null);
    client.clear();
  });

  it('sends no event when the retry after a transport failure succeeds', async () => {
    listFn
      .mockResolvedValueOnce({ ok: false, reason: 'transport', cause: new Error('socket closed') })
      .mockResolvedValueOnce(catalog);
    const { hook, unmount } = await mount();

    await waitFor(() => (hook()?.catalog ?? null) !== null);
    expect(listFn).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
    unmount();
  });

  it('sends one warning event with the cause when the retry also fails', async () => {
    const failure = new Error('socket closed');
    listFn.mockResolvedValue({ ok: false, reason: 'transport', cause: failure });
    const { hook, unmount } = await mount();

    await waitFor(() => hook()?.isLoading === false);
    expect(listFn).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'warning',
      fingerprint: ['cli-command-unavailable', 'list_models'],
      tags: { 'error.subsystem': 'cli-command', 'error.operation': 'list_models' },
    });
    expect(events[0]?.error).toBeInstanceOf(Error);
    expect(events[0]?.error).toMatchObject({
      message: 'instance catalog unavailable',
      cause: failure,
    });
    unmount();
  });

  it('sends no event for an unsupported CLI', async () => {
    listFn.mockResolvedValue({ ok: false, reason: 'unsupported' });
    const { hook, unmount } = await mount();

    await waitFor(() => hook()?.isLoading === false);
    expect(listFn).toHaveBeenCalledTimes(1);
    expect(hook()?.catalog).toBeNull();
    expect(events).toEqual([]);
    unmount();
  });
});
