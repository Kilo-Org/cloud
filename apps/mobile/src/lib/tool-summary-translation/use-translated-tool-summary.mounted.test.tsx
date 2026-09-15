import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setConfig } from './tool-summary-translation-runtime';
import { useTranslatedToolSummary } from './use-translated-tool-summary';

const { requestMock, readMock, writeMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock('./tool-summary-translation-client', () => ({
  requestToolSummaryTranslations: requestMock,
}));
// The encrypted-KV cache is a native module; the runtime loads it by dynamic
// import, so the suite mocks it the same way it mocks the client.
vi.mock('@/lib/persist/tool-summary-translation-cache', () => ({
  readToolSummaryTranslations: readMock,
  writeToolSummaryTranslation: writeMock,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'de' } }) }));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

type ProbeSpec = { text: string; enabled?: boolean; itemId?: string };

function Probe({
  text,
  enabled,
  itemId,
  onRender,
}: {
  text: string;
  enabled?: boolean;
  itemId?: string;
  onRender: (value: string) => void;
}) {
  const translated = useTranslatedToolSummary(text, enabled, itemId);
  onRender(translated);
  return null;
}

function mountProbes(specs: ProbeSpec[]): {
  latest: (index: number) => string;
  unmount: () => void;
} {
  const current: string[] = specs.map(() => '');
  const ref: { renderer: TestRenderer.ReactTestRenderer | undefined } = { renderer: undefined };
  act(() => {
    ref.renderer = TestRenderer.create(
      createElement(
        'View',
        null,
        ...specs.map((spec, index) =>
          createElement(Probe, {
            text: spec.text,
            enabled: spec.enabled,
            itemId: spec.itemId,
            onRender: value => {
              current[index] = value;
            },
          })
        )
      )
    );
  });
  const renderer = ref.renderer;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return {
    latest: index => current[index] ?? '',
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

function mount(spec: ProbeSpec): { latest: () => string; unmount: () => void } {
  const probes = mountProbes([spec]);
  return { latest: () => probes.latest(0), unmount: probes.unmount };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- real time for the batch window, then the macrotask that settles the dynamic import and request
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20);
      });
    }
  });
}

beforeEach(() => {
  requestMock.mockReset();
  readMock.mockReset();
  writeMock.mockReset();
  readMock.mockResolvedValue([]);
  writeMock.mockResolvedValue(undefined);
});

describe('useTranslatedToolSummary', () => {
  it('renders the raw text when the preference is off', async () => {
    requestMock.mockResolvedValue(['translated']);
    setConfig({ enabled: false, model: MODEL });
    const { latest, unmount } = mount({ text: 'Off summary', itemId: 'part-1' });

    await settle();

    expect(latest()).toBe('Off summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('renders the raw text when disabled for this row', async () => {
    requestMock.mockResolvedValue(['translated']);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount({
      text: 'Row-disabled summary',
      enabled: false,
      itemId: 'part-1',
    });

    await settle();

    expect(latest()).toBe('Row-disabled summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('never requests a translation for a row without an item id', async () => {
    requestMock.mockResolvedValue(['translated']);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount({ text: 'No id summary' });

    await settle();

    expect(latest()).toBe('No id summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('shows the translation once it resolves', async () => {
    requestMock.mockResolvedValue(['Bonjour']);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount({ text: 'Hello', itemId: 'part-1' });

    expect(latest()).toBe('Hello');
    await settle();

    expect(latest()).toBe('Bonjour');
    unmount();
  });

  it('keeps the raw text when the client rejects', async () => {
    requestMock.mockRejectedValue(new Error('gateway down'));
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount({ text: 'Uncached summary', itemId: 'part-1' });

    await settle();

    expect(latest()).toBe('Uncached summary');
    unmount();
  });

  it('resolves two rows with the same text but different ids from one batch', async () => {
    requestMock.mockResolvedValue(['Bonjour']);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mountProbes([
      { text: 'Same greeting', itemId: 'part-a' },
      { text: 'Same greeting', itemId: 'part-b' },
    ]);

    await settle();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(latest(0)).toBe('Bonjour');
    expect(latest(1)).toBe('Bonjour');
    // Each id owns its own persisted entry, so the rows never share a key.
    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(2);
    });
    const writtenIds = writeMock.mock.calls
      .map(call => (call[0] as { itemId: string }).itemId)
      .toSorted();
    expect(writtenIds).toEqual(['part-a', 'part-b']);
    unmount();
  });
});
