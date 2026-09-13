import { describe, expect, it, vi } from 'vitest';

import { modelFactsFor, RELAYED_SHAPE } from './layers';

// The catalog is read here without the device plugins the runtime builds around
// it, so the ones that only exist on a device are stubbed.
vi.mock('expo-crypto', () => ({ getRandomBytes: (count: number) => new Uint8Array(count) }));
vi.mock('@kilocode/harness-sdk/plugins/store/expo', () => ({ layerExpoStore: () => undefined }));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: vi.fn() }));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'http://localhost:4700' }));
vi.mock('./fetch', () => ({ chatFetch: () => undefined }));
vi.mock('./tools', () => ({ chatTools: () => [] }));

/**
 * What the app tells a session a gateway model can speak.
 *
 * The gateway resolves a model's shapes from the serving provider and refuses a
 * request on a shape that provider does not speak. The app cannot know them per
 * model, so the shape it asserts has to be the one every provider accepts —
 * otherwise a model served over `chat_completions` alone is refused with
 * "This model does not support the messages API" and the question fails to
 * deliver.
 */

describe('the shape a gateway model is asked over', () => {
  it('is chat_completions, which every provider the gateway relays speaks', () => {
    expect(modelFactsFor({ id: 'fake-deterministic' }).apiKinds).toEqual(['chat_completions']);
  });

  it('never claims the messages shape a chat_completions-only model is refused on', () => {
    expect(RELAYED_SHAPE.apiKinds).not.toContain('messages');
    expect(RELAYED_SHAPE.apiKinds).not.toContain('responses');
  });

  it('keeps the context window the gateway named for the model', () => {
    expect(modelFactsFor({ id: 'any', context_length: 200_000 })).toEqual({
      apiKinds: ['chat_completions'],
      contextWindow: 200_000,
    });
  });

  it('answers with a shape even when the gateway named no window', () => {
    expect(modelFactsFor({ id: 'unwindowed', context_length: null }).contextWindow).toBeUndefined();
  });
});
