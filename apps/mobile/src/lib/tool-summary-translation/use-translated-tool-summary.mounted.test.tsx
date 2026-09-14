/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React trees under vitest (same pattern as use-launch-folder.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setConfig } from './tool-summary-translation-runtime';
import { useTranslatedToolSummary } from './use-translated-tool-summary';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('./tool-summary-translation-client', () => ({
  requestToolSummaryTranslation: requestMock,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'de' } }) }));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

function Probe({
  text,
  enabled,
  onRender,
}: {
  text: string;
  enabled?: boolean;
  onRender: (value: string) => void;
}) {
  const translated = useTranslatedToolSummary(text, enabled);
  onRender(translated);
  return null;
}

function mount(text: string, enabled?: boolean): { latest: () => string; unmount: () => void } {
  let current = '';
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      createElement(Probe, {
        text,
        enabled,
        onRender: value => {
          current = value;
        },
      })
    );
  });
  return {
    latest: () => current,
    unmount: () => {
      act(() => {
        renderer?.unmount();
      });
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential macrotask flushes settle the dynamic import and request
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
    }
  });
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useTranslatedToolSummary', () => {
  it('renders the raw text when the preference is off', async () => {
    requestMock.mockResolvedValue('translated');
    setConfig({ enabled: false, model: MODEL });
    const { latest, unmount } = mount('Off summary');

    await settle();

    expect(latest()).toBe('Off summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('renders the raw text when disabled for this row', async () => {
    requestMock.mockResolvedValue('translated');
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount('Row-disabled summary', false);

    await settle();

    expect(latest()).toBe('Row-disabled summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('shows the translation once it resolves', async () => {
    requestMock.mockResolvedValue('Bonjour');
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount('Hello');

    expect(latest()).toBe('Hello');
    await settle();

    expect(latest()).toBe('Bonjour');
    unmount();
  });

  it('keeps the raw text when the client rejects', async () => {
    requestMock.mockRejectedValue(new Error('gateway down'));
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount('Uncached summary');

    await settle();

    expect(latest()).toBe('Uncached summary');
    unmount();
  });
});
