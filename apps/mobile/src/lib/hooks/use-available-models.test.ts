import { describe, expect, it, vi } from 'vitest';

import { toModelOptions } from './use-available-models';

// Stub native/expo modules so pure-node Vitest can resolve the
// module graph when importing from use-available-models.ts.
vi.mock('expo-secure-store', () => ({}));
vi.mock('@tanstack/react-query', () => ({}));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('@/lib/storage-keys', () => ({ AUTH_TOKEN_KEY: 'mock-token' }));

describe('toModelOptions', () => {
  it('passes pricing through to the ModelOption', () => {
    const pricing = { prompt: '0.00000175', completion: '0.000014' };
    const result = toModelOptions({
      data: [
        {
          id: 'priced/model',
          name: 'Display: Priced Model',
          pricing,
          preferredIndex: 0,
          opencode: { variants: { high: {} } },
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.pricing).toEqual(pricing);
    expect(result[0]?.id).toBe('priced/model');
    expect(result[0]?.name).toBe('Priced Model');
  });

  it('returns empty array for undefined data', () => {
    expect(toModelOptions(undefined)).toEqual([]);
  });
});
