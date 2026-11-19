/* eslint-disable import/first, jest/no-hooks, jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- the WXT module mock must precede the component import */
// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  items: new Map<string, unknown>(),
  sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(),
}));

vi.mock('#imports', () => ({
  browser: {
    permissions: { request: () => Promise.resolve(true) },
    runtime: { sendMessage: (message: unknown) => fixture.sendMessage(message) },
  },
  storage: {
    getItem: (key: string) => Promise.resolve(fixture.items.get(key) ?? null),
    removeItem: (key: string) => {
      fixture.items.delete(key);

      return Promise.resolve();
    },
    setItem: (key: string, value: unknown) => {
      fixture.items.set(key, value);

      return Promise.resolve();
    },
    watch: () => () => {
      /* The fixture never changes storage behind the page's back. */
    },
  },
}));

import { LocalAgentsSettings } from './local-agents-settings';

const CONTROLLER_ID = '11111111-2222-4333-8444-555555555555';
const HUB_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const STOP_ALL_FAILED = "Couldn't stop the agents. Try again.";
const DISCONNECT_FAILED = "Couldn't disconnect the agent. Try again.";

const seedRunningAgent = () => {
  fixture.items.set('local:kiloLocalAgentSettings', { enabled: true });
  fixture.items.set('session:kiloLocalAgentControllers', {
    controllers: [
      {
        connectedAt: 1,
        controllerId: CONTROLLER_ID,
        sessions: [
          {
            cliVersion: '1.0.0',
            cwd: '/tmp/project',
            openedAt: 1,
            sessionHandle: '99999999-8888-4777-8666-555555555555',
            sessionId: 'ses_1',
            title: 'Fix the tests',
          },
        ],
        transport: 'loopback',
      },
    ],
  });
};

describe('local agents settings', () => {
  beforeEach(() => {
    fixture.items.clear();
    fixture.sendMessage.mockReset();
  });

  it('says Stop all failed when the background answers that it did not run', async () => {
    seedRunningAgent();
    fixture.sendMessage.mockResolvedValue({ ok: false });
    const view = render(<LocalAgentsSettings />);

    fireEvent.click(await view.findByRole('button', { name: 'Stop all' }));

    await expect(view.findByText(STOP_ALL_FAILED)).resolves.toBeDefined();
    expect(view.queryByText("Couldn't save the setting. Try again.")).toBeNull();
    expect(fixture.sendMessage).toHaveBeenCalledWith({
      kind: 'stop_all',
      type: 'kilo-local-agents-command',
    });
  });

  it('says Disconnect failed when nothing answers the command', async () => {
    seedRunningAgent();
    fixture.sendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));
    const view = render(<LocalAgentsSettings />);

    fireEvent.click(await view.findByRole('button', { name: 'Disconnect 11111111' }));

    await expect(view.findByText(DISCONNECT_FAILED)).resolves.toBeDefined();
    expect(view.queryByText("Couldn't save the setting. Try again.")).toBeNull();
  });

  it('treats an answer it cannot read as a failure and clears the error once a retry runs', async () => {
    seedRunningAgent();
    fixture.sendMessage.mockResolvedValueOnce({}).mockResolvedValueOnce({ ok: true });
    const view = render(<LocalAgentsSettings />);
    const stopAll = await view.findByRole('button', { name: 'Stop all' });

    fireEvent.click(stopAll);
    await expect(view.findByText(STOP_ALL_FAILED)).resolves.toBeDefined();

    fireEvent.click(stopAll);
    await vi.waitFor(() => {
      expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(view.queryByText(STOP_ALL_FAILED)).toBeNull();
    });
  });

  it('shows a paired CLI that cannot be reached instead of the native-host hint', async () => {
    fixture.items.set('local:kiloLocalAgentSettings', { enabled: true });
    fixture.items.set('session:kiloLocalAgentStatus', {
      endpoints: [
        {
          endpointId: 'native',
          state: { kind: 'host_missing', reason: 'not_installed' },
          transport: 'native',
        },
        {
          address: '127.0.0.1:47917',
          endpointId: HUB_ID,
          hubId: HUB_ID,
          lastConnectedAt: 0,
          state: { attempt: 7, kind: 'backoff', until: 0 },
          transport: 'loopback',
        },
      ],
    });
    const view = render(<LocalAgentsSettings />);

    await expect(view.findByText('Kilo CLI · 127.0.0.1:47917')).resolves.toBeDefined();
    expect(view.getByText('Not reachable')).toBeDefined();
    expect(
      view.getByText(
        'Start the Kilo CLI again to pair this browser. An entry that stays unreachable is removed after a day.'
      )
    ).toBeDefined();
    expect(view.queryByText('Kilo CLI not found. Run any Kilo CLI command once.')).toBeNull();
  });
});
