// Shared harness for reply-input.mounted.test.tsx: the renderer registry, the
// field/button probes, and the settle wrapper the submit cases await.

import { type ReactElement } from 'react';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

const mounted: ReactTestRenderer[] = [];

export async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(element);
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

export function unmountAll(): void {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
}

export function field(renderer: ReactTestRenderer) {
  return renderer.root.findByType('TextInput');
}

function submitButton(renderer: ReactTestRenderer) {
  return renderer.root.findByType('Button');
}

export function typeBody(renderer: ReactTestRenderer, text: string): void {
  act(() => {
    (field(renderer).props.onChangeText as (value: string) => void)(text);
  });
}

export function pressReply(renderer: ReactTestRenderer): void {
  act(() => {
    (submitButton(renderer).props.onPress as () => void)();
  });
}

/** Presses Reply and lets the submit promise settle before act returns. */
export async function pressReplyAndSettle(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    pressReply(renderer);
    await Promise.resolve();
  });
}

export function failureCopy(renderer: ReactTestRenderer): string | undefined {
  const text = renderer.root.findAllByType('Text')[0];
  return text?.props.children as string | undefined;
}

export function hasReconnectNotice(renderer: ReactTestRenderer): boolean {
  return renderer.root.findAllByType('PrReviewReconnectNotice').length > 0;
}

export function replyEnabled(renderer: ReactTestRenderer): boolean {
  return submitButton(renderer).props.disabled === false;
}
