/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import '@/i18n';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { assistantMessage } from './message-bubble-test-utils';
import { MessageLongPressProvider, useMessageLongPress } from './message-long-press-context';

let captured: (() => void) | null | undefined = undefined;

function LongPressProbe(): null {
  captured = useMessageLongPress();
  return null;
}

async function mountProvider(
  message: ReturnType<typeof assistantMessage>,
  onLongPressDetails?: (m: unknown) => void
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(
        MessageLongPressProvider,
        { message, onLongPressDetails },
        createElement(LongPressProbe)
      )
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('MessageLongPressProvider mounted', () => {
  it('provides a handler that opens the details for its message', async () => {
    const message = assistantMessage('m-provider');
    const onLongPressDetails = vi.fn<(m: unknown) => void>();
    await mountProvider(message, onLongPressDetails);
    expect(typeof captured).toBe('function');
    captured?.();
    expect(onLongPressDetails).toHaveBeenCalledWith(message);
  });

  it('provides no handler when no details sheet is wired', async () => {
    captured = undefined;
    await mountProvider(assistantMessage('m-provider-plain'));
    expect(captured).toBeNull();
  });

  it('keeps the handler identity stable across re-renders of the same message', async () => {
    const message = assistantMessage('m-provider-stable');
    const onLongPressDetails = vi.fn<(m: unknown) => void>();
    const renderer = await mountProvider(message, onLongPressDetails);
    const first = captured;
    await act(async () => {
      await Promise.resolve();
      renderer.update(
        createElement(
          MessageLongPressProvider,
          { message, onLongPressDetails },
          createElement(LongPressProbe)
        )
      );
    });
    expect(captured).toBe(first);
  });

  it('swaps to the tap-only value when the details sheet unmounts', async () => {
    const message = assistantMessage('m-provider-toggle');
    const onLongPressDetails = vi.fn<(m: unknown) => void>();
    const renderer = await mountProvider(message, onLongPressDetails);
    expect(typeof captured).toBe('function');
    await act(async () => {
      await Promise.resolve();
      renderer.update(createElement(LongPressProbe));
    });
    expect(captured).toBeNull();
  });

  it('defaults the context to null outside a provider', async () => {
    captured = undefined;
    await act(async () => {
      await Promise.resolve();
      TestRenderer.create(createElement(LongPressProbe));
    });
    expect(captured).toBeNull();
  });
});
