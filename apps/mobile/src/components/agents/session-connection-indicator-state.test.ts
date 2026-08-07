import { describe, expect, it } from 'vitest';

import {
  resolveSessionConnectionState,
  type SessionConnectionState,
} from '@/components/agents/session-connection-indicator-state';

type StatusType = 'idle' | 'autocommit' | 'error' | 'disconnected' | 'interrupted';

const STATUSES: StatusType[] = ['idle', 'autocommit', 'error', 'disconnected', 'interrupted'];
const CONNECTION_VALUES: boolean[] = [true, false];

function resolve(input: {
  activeSessionType: 'remote' | 'cloud-agent' | 'read-only' | null;
  agentStatusType: StatusType;
  userWebConnected: boolean;
}): SessionConnectionState {
  return resolveSessionConnectionState(input);
}

describe('resolveSessionConnectionState - remote', () => {
  it('reports down for every status when the mobile user-web leg is down', () => {
    for (const status of STATUSES) {
      expect(
        resolve({ activeSessionType: 'remote', agentStatusType: status, userWebConnected: false })
      ).toBe('down');
    }
  });

  it('reports down for a disconnected agent status even while the user-web leg is up', () => {
    expect(
      resolve({
        activeSessionType: 'remote',
        agentStatusType: 'disconnected',
        userWebConnected: true,
      })
    ).toBe('down');
  });

  it('reports up for agent lifecycle statuses other than disconnected while connected', () => {
    for (const status of STATUSES.filter(item => item !== 'disconnected')) {
      expect(
        resolve({ activeSessionType: 'remote', agentStatusType: status, userWebConnected: true })
      ).toBe('up');
    }
  });
});

describe('resolveSessionConnectionState - cloud-agent', () => {
  it('reports up for non-disconnected statuses without consulting the user-web leg', () => {
    for (const status of STATUSES.filter(item => item !== 'disconnected')) {
      for (const userWebConnected of CONNECTION_VALUES) {
        expect(
          resolve({ activeSessionType: 'cloud-agent', agentStatusType: status, userWebConnected })
        ).toBe('up');
      }
    }
  });

  it('reports down for a disconnected agent status regardless of the user-web leg', () => {
    for (const userWebConnected of CONNECTION_VALUES) {
      expect(
        resolve({
          activeSessionType: 'cloud-agent',
          agentStatusType: 'disconnected',
          userWebConnected,
        })
      ).toBe('down');
    }
  });
});

describe('resolveSessionConnectionState - no transport', () => {
  it('reports none for read-only sessions across every status and connection value', () => {
    for (const status of STATUSES) {
      for (const userWebConnected of CONNECTION_VALUES) {
        expect(
          resolve({ activeSessionType: 'read-only', agentStatusType: status, userWebConnected })
        ).toBe('none');
      }
    }
  });

  it('reports none while the session type is unresolved across every status and connection value', () => {
    for (const status of STATUSES) {
      for (const userWebConnected of CONNECTION_VALUES) {
        expect(
          resolve({ activeSessionType: null, agentStatusType: status, userWebConnected })
        ).toBe('none');
      }
    }
  });
});
