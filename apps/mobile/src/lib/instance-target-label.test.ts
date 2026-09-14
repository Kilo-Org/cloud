import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { type InstancePickerInstance } from '@/lib/picker-bridge';

import {
  cloudAgentTargetLabel,
  formatInstanceTarget,
  resolveRunningOnLabel,
} from './instance-target-label';

function instance(overrides: Partial<InstancePickerInstance>): InstancePickerInstance {
  return {
    connectionId: 'conn-1',
    name: 'laptop',
    projectName: 'kilo',
    kind: 'cli',
    startedAt: null,
    gitBranch: null,
    ...overrides,
  };
}

describe('formatInstanceTarget', () => {
  it('matches the new-session picker target label', () => {
    expect(formatInstanceTarget(instance({ name: 'laptop', projectName: 'kilo' }))).toBe(
      'laptop · kilo'
    );
  });
});

describe('resolveRunningOnLabel', () => {
  it('returns null for a read-only session', () => {
    expect(
      resolveRunningOnLabel({
        activeSessionType: 'read-only',
        ownerConnectionId: null,
        instances: [],
      })
    ).toBeNull();
  });

  it('returns null before the session type resolves', () => {
    expect(
      resolveRunningOnLabel({
        activeSessionType: null,
        ownerConnectionId: null,
        instances: [],
      })
    ).toBeNull();
  });

  it('labels the Cloud Agent target for a live cloud session', () => {
    expect(
      resolveRunningOnLabel({
        activeSessionType: 'cloud-agent',
        ownerConnectionId: null,
        instances: [],
      })
    ).toBe(i18n.t('agentChat.instancePicker.cloudAgent'));
    expect(cloudAgentTargetLabel()).toBe(i18n.t('agentChat.instancePicker.cloudAgent'));
  });

  it('labels the owning instance for a live CLI session', () => {
    expect(
      resolveRunningOnLabel({
        activeSessionType: 'remote',
        ownerConnectionId: 'conn-2',
        instances: [
          instance({ connectionId: 'conn-1', name: 'laptop', projectName: 'kilo' }),
          instance({ connectionId: 'conn-2', name: 'desktop', projectName: 'cloud' }),
        ],
      })
    ).toBe('desktop · cloud');
  });

  it('returns null when the live CLI instance is not in the connected list', () => {
    expect(
      resolveRunningOnLabel({
        activeSessionType: 'remote',
        ownerConnectionId: 'conn-missing',
        instances: [instance({ connectionId: 'conn-1' })],
      })
    ).toBeNull();
  });

  it('does not match a null owner connection to an instance', () => {
    expect(
      resolveRunningOnLabel({
        activeSessionType: 'remote',
        ownerConnectionId: null,
        instances: [instance({ connectionId: 'conn-1' })],
      })
    ).toBeNull();
  });
});
