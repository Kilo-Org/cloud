import { beforeEach, describe, expect, it, vi } from 'vitest';

import { instancePickerFixtureRoute } from './instance-picker-fixture';

const slot = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock('@/lib/route-registry', () => ({
  UNFENCED_ROUTE_KEY: 'unscoped',
  instancePickerSlot: { set: slot.set },
}));

beforeEach(() => {
  slot.set.mockReset();
});

describe('instancePickerFixtureRoute', () => {
  it('opens the sheet on the Cloud Agent target', () => {
    expect(instancePickerFixtureRoute('/dev/instance-picker-fixture/cloud')).toBe(
      '/(app)/agent-chat/instance-picker'
    );
    expect(slot.set).toHaveBeenCalledWith('unscoped', {
      instances: [],
      currentValue: null,
      pendingComputer: false,
      onSelect: expect.any(Function),
    });
  });

  it('opens the sheet on a computer the live list does not list', () => {
    expect(instancePickerFixtureRoute('/dev/instance-picker-fixture/instance')).toBe(
      '/(app)/agent-chat/instance-picker'
    );
    expect(slot.set.mock.calls[0]?.[1]).toMatchObject({
      currentValue: {
        connectionId: 'fixture-stale-connection',
        name: 'fixture-host',
        projectName: 'fixture-project',
      },
    });
  });

  it('names the computer the link carries', () => {
    expect(
      instancePickerFixtureRoute('/dev/instance-picker-fixture/instance?name=host-a&project=proj')
    ).toBe('/(app)/agent-chat/instance-picker');
    expect(slot.set.mock.calls[0]?.[1]).toMatchObject({
      currentValue: { name: 'host-a', projectName: 'proj' },
    });
  });

  it('leaves every other link to the app router', () => {
    expect(instancePickerFixtureRoute('/dev/profile-picker-fixture')).toBeNull();
    expect(instancePickerFixtureRoute('/(app)/agent-chat/instance-picker')).toBeNull();
    expect(slot.set).not.toHaveBeenCalled();
  });
});
