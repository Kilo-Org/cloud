import { vi } from 'vitest';

vi.mock('cloudflare:durable-objects', () => ({
  retryable: vi.fn((...methods: unknown[]) => {
    if (methods.some(method => typeof method !== 'function')) {
      throw new TypeError('retryable requires prototype methods');
    }
  }),
}));
