/* eslint-disable jest/no-hooks, jest/require-top-level-describe -- Global RTL cleanup must run afterEach; vitest globals are off so RTL cannot self-register. */
import { afterEach } from 'vitest';

// With globals disabled, @testing-library/react cannot register its own cleanup. Renders would accumulate across tests.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});
