// The store latches before its first read publishes. Without that order a view
// that renders on the published snapshot reads the store again, re-enters the
// bootstrap, and runs a second read while the first is still publishing; a device
// whose second read is refused then leaves the picker showing the model row
// beside "Could not load models", and the retry early-returns on the latch the
// first read set. This suite mounts the real section against the real store, so
// every read below is one the store itself issued.
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ggufModelProvider } from '@/lib/chat/gguf-models';
import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

import { GgufModelSection } from './gguf-model-section';

const fsMock = vi.hoisted(() => ({
  files: new Map<string, number>([
    ['models.json', 0],
    ['small.gguf', 10],
  ]),
  // Text `JSON.parse` rejects until the repair writes a list back.
  indexText: '{ not json',
  reads: 0,
}));

const appState = vi.hoisted(() => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })) }));

vi.mock('react-native', () => ({
  View: 'View',
  AppState: { addEventListener: appState.addEventListener },
  Platform: { OS: 'android' },
}));

vi.mock('expo', () => ({
  requireNativeModule: () => ({ sha256File: () => Promise.resolve('a'.repeat(64)) }),
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: () => Promise.resolve('digest'),
}));

vi.mock('llama.rn', () => ({ initLlama: vi.fn() }));

// The in-memory document directory. The first read is refused (the corrupt
// first attempt the picker reports), the read of the retry the person pressed
// answers the repaired list, and any later read is refused too: that later read
// is the one a second load issues during the first load's publish, and the
// device in this scenario refuses it.
vi.mock('expo-file-system', () => {
  function MockDirectory() {
    return {
      exists: true,
      create: () => undefined,
      list: () => [...fsMock.files.keys()].map(name => ({ name })),
    };
  }
  function MockFile(_directory: unknown, name: string) {
    return {
      get exists() {
        return fsMock.files.has(name);
      },
      get size() {
        return fsMock.files.get(name) ?? 0;
      },
      get uri() {
        return `/documents/gguf-models/${name}`;
      },
      delete: () => {
        fsMock.files.delete(name);
      },
      moveSync: () => undefined,
      writeSync: () => undefined,
      textSync: () => {
        fsMock.reads += 1;
        if (fsMock.reads !== 2) {
          throw new Error('storage unavailable');
        }
        return fsMock.indexText;
      },
    };
  }
  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { document: '/documents', availableDiskSpace: 8_000_000_000 },
  };
});

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/icons', () => ({ PackageSearch: 'PackageSearch' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/chat/backend-provider-choices', () => ({
  BackendProviderChoice: 'BackendProviderChoice',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));

const REPAIRED = JSON.stringify([
  {
    fileId: 'small',
    name: 'Small model',
    url: 'https://example.com/small.gguf',
    sizeBytes: 10,
    contextWindow: 4096,
    tools: false,
    vision: false,
    thinking: false,
  },
]);

let view: RenderWithProvidersResult | undefined = undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function textOf(result: RenderWithProvidersResult): string[] {
  return result.renderer.root
    .findAll(node => (node.type as string) === 'Text')
    .map(node => node.props.children as string);
}

function retryButton(result: RenderWithProvidersResult) {
  const retry = result.renderer.root
    .findAll(node => (node.type as string) === 'Button')
    .find(button =>
      button
        .findAll(node => (node.type as string) === 'Text')
        .some(node => node.props.children === 'Try again')
    );
  if (!retry) {
    throw new Error('the retry control was not rendered');
  }
  return retry;
}

describe('the saved-list retry after a failed read', () => {
  it('replaces the load failure with the model row on one read', async () => {
    view = await renderWithProviders(
      createElement(GgufModelSection, { onBrowse: () => undefined })
    );

    // The corrupt first read is reported, and it spent the one read it made.
    expect(textOf(view)).toContain('Could not load models');
    expect(fsMock.reads).toBe(1);

    fsMock.indexText = REPAIRED;
    const retry = retryButton(view);
    await act(async () => {
      (retry.props.onPress as () => void)();
      await Promise.resolve();
    });

    // The card is gone, the saved model is drawn, and the provider answers about
    // it. A load that ran during the publish would have read again and failed
    // over the list that just arrived, so the read count is part of the verdict.
    const text = textOf(view);
    expect(fsMock.reads).toBe(2);
    expect(text).not.toContain('Could not load models');
    expect(
      view.renderer.root
        .findAll(node => (node.type as string) === 'BackendProviderChoice')
        .map(node => node.props.name)
    ).toContain('Small model');
    await expect(ggufModelProvider.availability()).resolves.toMatchObject({ status: 'available' });
    expect(fsMock.reads).toBe(2);
    expect(appState.addEventListener).toHaveBeenCalledTimes(1);
  });
});
