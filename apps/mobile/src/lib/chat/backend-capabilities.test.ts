import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  rememberKiloImageModels,
  targetSupportsImages,
  targetSupportsTools,
} from './backend-capabilities';
import { type StoredChatBackend } from './backend-store';
import { backendTargetId, localTargetId } from './backend-target';

const stored = vi.hoisted(() => ({ backends: [] as StoredChatBackend[] }));

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('./backend-store', () => ({
  listChatBackends: () => stored.backends,
  useChatBackends: () => stored.backends,
}));
vi.mock('./local-models', () => ({
  localModelProvider: (provider: string) => {
    if (provider === 'gguf') {
      return { supportsTools: () => true, supportsImages: (id: string) => id === 'vision' };
    }
    return provider === 'apple'
      ? { supportsTools: () => false, supportsImages: () => false }
      : undefined;
  },
}));

const backend: StoredChatBackend = {
  id: '00000000-0000-4000-8000-000000000001',
  revision: 1,
  name: 'Custom',
  baseUrl: 'https://provider.example/v1',
  apiKind: 'chat_completions',
  apiKey: '',
  headers: {},
  models: [
    { id: 'reads', name: 'Reads', tools: false, images: true },
    { id: 'text', name: 'Text', tools: true, images: false },
  ],
  allowLocalHttp: false,
};

beforeEach(() => {
  stored.backends = [backend];
  rememberKiloImageModels([]);
});

describe('image support', () => {
  it('follows the gateway catalog for a Kilo model, and reads an unlisted one as text-only', () => {
    expect(targetSupportsImages('vendor/vision')).toBe(false);

    rememberKiloImageModels([
      { id: 'vendor/vision', supportsImages: true },
      { id: 'vendor/text', supportsImages: false },
    ]);

    expect(targetSupportsImages('vendor/vision')).toBe(true);
    expect(targetSupportsImages('vendor/text')).toBe(false);
    expect(targetSupportsImages('vendor/missing')).toBe(false);
    expect(targetSupportsTools('vendor/text')).toBe(true);

    rememberKiloImageModels([{ id: 'vendor/text' }]);
    expect(targetSupportsImages('vendor/vision')).toBe(false);
  });

  it('follows the per-model flag of a custom backend, apart from its tool flag', () => {
    expect(targetSupportsImages(backendTargetId(backend, 'reads'))).toBe(true);
    expect(targetSupportsTools(backendTargetId(backend, 'reads'))).toBe(false);
    expect(targetSupportsImages(backendTargetId(backend, 'text'))).toBe(false);
    expect(targetSupportsTools(backendTargetId(backend, 'text'))).toBe(true);
  });

  it('asks the on-device provider, and reads a provider this build lacks as text-only', () => {
    expect(targetSupportsImages(localTargetId('apple'))).toBe(false);
    expect(targetSupportsImages(localTargetId('gguf', 'vision'))).toBe(true);
    expect(targetSupportsImages(localTargetId('gguf', 'plain'))).toBe(false);
    expect(targetSupportsImages(localTargetId('android'))).toBe(false);
  });
});
