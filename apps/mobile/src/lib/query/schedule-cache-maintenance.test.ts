import { InteractionManager } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { scheduleCacheMaintenance } from '@/lib/query/schedule-cache-maintenance';

vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
}));

describe('scheduleCacheMaintenance', () => {
  it('runs the callback through InteractionManager.runAfterInteractions', () => {
    const run = vi.fn<() => void>();

    scheduleCacheMaintenance(run);

    // eslint-disable-next-line typescript-eslint/unbound-method, typescript-eslint/no-deprecated -- the mock is a plain vi.fn() with no `this`, and runAfterInteractions is the documented deferral API.
    expect(InteractionManager.runAfterInteractions).toHaveBeenCalledWith(run);
  });
});
