import { describe, expect, it } from 'vitest';
import type { LocalAgentConnectedAgent } from '@/src/shared/local-agents/registry';
import type { LocalAgentEndpointStatus } from '@/src/shared/local-agents/status';
import {
  LOOPBACK_RECONNECT_GRACE_MS,
  deriveLocalAgentsSettingsView,
} from './local-agents-settings-state';

const NOW = 10_000_000;
const HUB_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

const agent = (controllerId: string): LocalAgentConnectedAgent => ({
  cliVersion: '1.0.0',
  controllerId,
  cwd: '/tmp',
  sessionHandle: `${controllerId}-session`,
  sessionId: 's',
  title: 't',
  transport: 'loopback',
});

const endpoint = (state: LocalAgentEndpointStatus['state']): LocalAgentEndpointStatus => ({
  endpointId: 'native',
  state,
  transport: 'native',
});

const loopback = (
  state: LocalAgentEndpointStatus['state'],
  lastConnectedAt?: number
): LocalAgentEndpointStatus => ({
  address: '127.0.0.1:47917',
  endpointId: HUB_ID,
  hubId: HUB_ID,
  ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
  state,
  transport: 'loopback',
});

const viewOf = (status: LocalAgentEndpointStatus[], enabled: boolean | undefined) =>
  deriveLocalAgentsSettingsView({ agents: [], enabled, now: NOW, status });

describe('local agents settings view', () => {
  it('shows nothing while the switch value is unknown or off', () => {
    const unknown = deriveLocalAgentsSettingsView({
      agents: [],
      enabled: undefined,
      now: NOW,
      status: [loopback({ attempt: 1, kind: 'connected' }, NOW)],
    });

    expect(unknown.emptyState).toBe('none');
    expect(viewOf([], false).emptyState).toBe('none');
    expect(viewOf([loopback({ attempt: 1, kind: 'connected' }, NOW)], false)).toStrictEqual({
      controllerGroups: [],
      emptyState: 'none',
      enabled: false,
      loopbackEndpoints: [],
    });
  });

  it('lists controllers and hides every empty state once agents exist', () => {
    const view = deriveLocalAgentsSettingsView({
      agents: [agent('a'), agent('a'), agent('b')],
      enabled: true,
      now: NOW,
      status: [endpoint({ kind: 'host_missing', reason: 'not_installed' })],
    });

    expect(view.emptyState).toBe('none');
    expect(view.controllerGroups).toHaveLength(2);
    expect(view.controllerGroups[0]?.agents).toHaveLength(2);
  });

  it('prefers a live connection over a missing native host', () => {
    expect(
      viewOf(
        [
          endpoint({ kind: 'host_missing', reason: 'not_installed' }),
          endpoint({ attempt: 1, kind: 'connected' }),
        ],
        true
      ).emptyState
    ).toBe('connected');
  });

  it('keeps the missing-host reason so the hint matches the cause', () => {
    expect(
      viewOf([endpoint({ kind: 'host_missing', reason: 'not_installed' })], true).emptyState
    ).toBe('host_missing_not_installed');
    expect(
      viewOf([endpoint({ kind: 'host_missing', reason: 'permission_denied' })], true).emptyState
    ).toBe('host_missing_permission');
  });

  it('waits while the transport is still dialing', () => {
    expect(viewOf([endpoint({ attempt: 1, kind: 'connecting' })], true).emptyState).toBe('waiting');
  });

  it('shows a paired CLI that dropped instead of the native-host hint', () => {
    const view = viewOf(
      [
        endpoint({ kind: 'host_missing', reason: 'not_installed' }),
        loopback({ attempt: 3, kind: 'backoff', until: NOW + 4000 }, NOW - 10_000),
      ],
      true
    );

    expect(view.emptyState).toBe('none');
    expect(view.loopbackEndpoints).toStrictEqual([
      { address: '127.0.0.1:47917', endpointId: HUB_ID, reachability: 'reconnecting' },
    ]);
  });

  it('calls a paired CLI unreachable once it has been gone longer than the grace period', () => {
    const backoff: LocalAgentEndpointStatus['state'] = {
      attempt: 7,
      kind: 'backoff',
      until: NOW + 60_000,
    };

    expect(
      viewOf([loopback(backoff, NOW - LOOPBACK_RECONNECT_GRACE_MS - 1)], true).loopbackEndpoints[0]
        ?.reachability
    ).toBe('unreachable');
    expect(
      viewOf([loopback(backoff, NOW - LOOPBACK_RECONNECT_GRACE_MS + 1)], true).loopbackEndpoints[0]
        ?.reachability
    ).toBe('reconnecting');
    // No record of it ever being reachable in this browser session.
    expect(viewOf([loopback(backoff)], true).loopbackEndpoints[0]?.reachability).toBe(
      'unreachable'
    );
  });

  it('shows a connected CLI as connected, with the idle hint', () => {
    const view = viewOf([loopback({ attempt: 1, kind: 'connected' }, NOW - 3_600_000)], true);

    expect(view.emptyState).toBe('connected');
    expect(view.loopbackEndpoints[0]?.reachability).toBe('connected');
  });
});
