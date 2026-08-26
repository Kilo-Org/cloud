import { describe, expect, it } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';

import { resolveLiveInstance } from './resolve-live-instance';

const SELECTED: InstancePickerInstance = {
  connectionId: 'conn-stale',
  name: 'host-a',
  projectName: 'proj',
};

describe('resolveLiveInstance', () => {
  it('returns the instance with the same connectionId', () => {
    const live: InstancePickerInstance = {
      connectionId: 'conn-stale',
      name: 'host-a',
      projectName: 'proj',
      version: '1.2.3',
    };

    expect(resolveLiveInstance(SELECTED, [live])).toBe(live);
  });

  it('returns the instance with the same name and projectName when the id differs', () => {
    const live: InstancePickerInstance = {
      connectionId: 'conn-live',
      name: 'host-a',
      projectName: 'proj',
    };

    expect(resolveLiveInstance(SELECTED, [live])).toBe(live);
  });

  it('returns null when no instance matches the id or the name/project pair', () => {
    const unrelated: InstancePickerInstance = {
      connectionId: 'conn-other',
      name: 'host-b',
      projectName: 'other',
    };

    expect(resolveLiveInstance(SELECTED, [unrelated])).toBeNull();
    expect(resolveLiveInstance(SELECTED, [])).toBeNull();
  });
});
