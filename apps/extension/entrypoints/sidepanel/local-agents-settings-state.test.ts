import { describe, expect, it } from 'vitest';
import type { LocalAgentConnectedAgent } from '@/src/shared/local-agents/registry';
import type { LocalAgentEndpointStatus } from '@/src/shared/local-agents/status';
import { deriveLocalAgentsSettingsView } from './local-agents-settings-state';

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

describe('local agents settings view', () => {
  it('shows nothing while the switch value is unknown or off', () => {
    expect(
      deriveLocalAgentsSettingsView({ agents: [], enabled: undefined, status: [] }).emptyState
    ).toBe('none');
    expect(
      deriveLocalAgentsSettingsView({ agents: [], enabled: false, status: [] }).emptyState
    ).toBe('none');
  });

  it('lists controllers and hides every empty state once agents exist', () => {
    const view = deriveLocalAgentsSettingsView({
      agents: [agent('a'), agent('a'), agent('b')],
      enabled: true,
      status: [endpoint({ kind: 'host_missing', reason: 'not_installed' })],
    });

    expect(view.emptyState).toBe('none');
    expect(view.controllerGroups).toHaveLength(2);
    expect(view.controllerGroups[0]?.agents).toHaveLength(2);
  });

  it('prefers a live connection over a missing native host', () => {
    const view = deriveLocalAgentsSettingsView({
      agents: [],
      enabled: true,
      status: [
        endpoint({ kind: 'host_missing', reason: 'not_installed' }),
        endpoint({ attempt: 1, kind: 'connected' }),
      ],
    });

    expect(view.emptyState).toBe('connected');
  });

  it('keeps the missing-host reason so the hint matches the cause', () => {
    expect(
      deriveLocalAgentsSettingsView({
        agents: [],
        enabled: true,
        status: [endpoint({ kind: 'host_missing', reason: 'not_installed' })],
      }).emptyState
    ).toBe('host_missing_not_installed');
    expect(
      deriveLocalAgentsSettingsView({
        agents: [],
        enabled: true,
        status: [endpoint({ kind: 'host_missing', reason: 'permission_denied' })],
      }).emptyState
    ).toBe('host_missing_permission');
  });

  it('waits while the transport is still dialing', () => {
    expect(
      deriveLocalAgentsSettingsView({
        agents: [],
        enabled: true,
        status: [endpoint({ attempt: 1, kind: 'connecting' })],
      }).emptyState
    ).toBe('waiting');
  });
});
