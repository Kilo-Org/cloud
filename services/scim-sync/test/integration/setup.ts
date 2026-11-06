import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, vi } from 'vitest';

// Each test starts from an empty Durable Object: the loop's whole behaviour is
// about accumulated cursor and failure state.
beforeEach(async () => {
  await reset();
});

// The harness stubs `fetch`, and a leaked stub would serve another test's
// pages.
afterEach(() => {
  vi.unstubAllGlobals();
});
