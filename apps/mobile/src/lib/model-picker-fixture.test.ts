import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ModelPickerBridge } from './picker-bridge';
import { modelPickerFixtureRoute } from './model-picker-fixture';

const slot = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock('@/lib/route-registry', () => ({
  modelPickerSlot: { set: slot.set },
}));

const route = '/(app)/agent-chat/model-picker?routeKey=model-picker-fixture';

/** The bridge the branch just stored; a branch that stored none fails here. */
function storedBridge(): ModelPickerBridge {
  const call = slot.set.mock.calls[0];
  if (!call) {
    throw new Error('fixture stored no bridge');
  }
  return call[1] as ModelPickerBridge;
}

beforeEach(() => {
  slot.set.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('modelPickerFixtureRoute', () => {
  // The composer's chip opens the picker with the catalog it holds, so this
  // branch is the zero-row state: nothing to list, but a refetch to offer.
  it('opens the picker on an empty catalog the session can refetch', () => {
    expect(modelPickerFixtureRoute('/dev/model-picker-fixture/multiple-providers?empty=1')).toBe(
      route
    );

    const bridge = storedBridge();
    expect(bridge.options).toEqual([]);
    expect(bridge.currentValue).toBe('');
    expect(bridge.acceptsVariant).toBe(true);
    expect(bridge.retryCatalog).toBeTypeOf('function');
  });

  it('records the retry instead of reaching a backend it cannot', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    modelPickerFixtureRoute('/dev/model-picker-fixture/multiple-providers?empty=1');

    expect(() => {
      storedBridge().retryCatalog?.();
    }).not.toThrow();
    expect(info).toHaveBeenCalledTimes(1);
  });

  // A CLI that reports no models projects one dead row carrying the session's
  // selection, so the sheet has rows but nothing selectable.
  it('opens the picker on the one dead row when every model is unavailable', () => {
    expect(
      modelPickerFixtureRoute('/dev/model-picker-fixture/multiple-providers?unavailable=1')
    ).toBe(route);

    const { options } = storedBridge();
    expect(options).toHaveLength(1);
    expect(options[0]?.unavailable).toBe(true);
  });

  it('opens the picker on the multi-provider catalog the link names', () => {
    expect(modelPickerFixtureRoute('/dev/model-picker-fixture/multiple-providers')).toBe(route);
    expect(storedBridge().options.length).toBeGreaterThan(1);
  });

  it('leaves every other link to the app router', () => {
    expect(modelPickerFixtureRoute('/dev/other-fixture')).toBeNull();
    expect(modelPickerFixtureRoute('/(app)/agent-chat/model-picker')).toBeNull();
    expect(slot.set).not.toHaveBeenCalled();
  });
});
