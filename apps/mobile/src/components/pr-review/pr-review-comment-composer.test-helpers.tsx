// Shared harness for pr-review-comment-composer.mounted.test.tsx: the renderer
// registry, the base props, and the element probes the cases read.

import { createElement } from 'react';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { PrReviewCommentComposer } from './pr-review-comment-composer';

type ComposerProps = Parameters<typeof PrReviewCommentComposer>[0];

const mounted: ReactTestRenderer[] = [];

export async function mountComposer(props: ComposerProps): Promise<ReactTestRenderer> {
  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(createElement(PrReviewCommentComposer, props));
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

export function button(renderer: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return renderer.root
    .findAllByType('Button')
    .find(node => node.props.accessibilityLabel === label);
}

export function press(renderer: ReactTestRenderer, label: string): void {
  const target = button(renderer, label);
  if (!target) {
    throw new Error(`no ${label} button`);
  }
  act(() => {
    (target.props.onPress as () => void)();
  });
}

export async function pressAndSettle(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    press(renderer, label);
    await Promise.resolve();
  });
}

export function typeBody(renderer: ReactTestRenderer, text: string): void {
  const field = renderer.root.findByType('TextInput');
  act(() => {
    (field.props.onChangeText as (value: string) => void)(text);
  });
}

export function hasCopy(renderer: ReactTestRenderer, copy: string): boolean {
  return renderer.root.findAllByType('Text').some(node => node.props.children === copy);
}

export function hasReconnectNotice(renderer: ReactTestRenderer): boolean {
  return renderer.root.findAllByType('PrReviewReconnectNotice').length > 0;
}

export function isDisabled(renderer: ReactTestRenderer, label: string): boolean {
  return button(renderer, label)?.props.disabled === true;
}
