import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextPickerFixtureRoute } from './context-picker-fixture';

const slot = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock('@/lib/route-registry', () => ({
  UNFENCED_ROUTE_KEY: 'unscoped',
  contextPickerSlot: { set: slot.set },
}));

beforeEach(() => {
  slot.set.mockReset();
});

describe('contextPickerFixtureRoute', () => {
  it('writes the rows the sheet renders and opens the sheet route', () => {
    expect(contextPickerFixtureRoute('/dev/context-picker-fixture')).toBe('/(app)/context-picker');
    expect(slot.set).toHaveBeenCalledExactlyOnceWith('unscoped', {
      options: ['Fixture Personal', 'Fixture Acme'],
      currentIndex: 0,
      onSelect: expect.any(Function),
    });
  });

  it('accepts a trailing slash and a query', () => {
    expect(contextPickerFixtureRoute('/dev/context-picker-fixture/')).toBe('/(app)/context-picker');
    expect(contextPickerFixtureRoute('/dev/context-picker-fixture?x=1')).toBe(
      '/(app)/context-picker'
    );
    expect(slot.set).toHaveBeenCalledTimes(2);
  });

  it('leaves every other link to the app router', () => {
    expect(contextPickerFixtureRoute('/dev/profile-picker-fixture')).toBeNull();
    expect(contextPickerFixtureRoute('/dev/instance-picker-fixture/cloud')).toBeNull();
    expect(contextPickerFixtureRoute('/(app)/context-picker')).toBeNull();
    expect(slot.set).not.toHaveBeenCalled();
  });
});
