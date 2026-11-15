// Shared harness for pr-comment-edit-sheet.mounted.test.tsx: the renderer
// registry and the element probes the cases read.

import { type ReactElement } from 'react';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';

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

export function typeBody(renderer: ReactTestRenderer, text: string): void {
  act(() => {
    (renderer.root.findByType('CommentBodyField').props.onChangeText as (value: string) => void)(
      text
    );
  });
}

function buttonByText(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const [found] = renderer.root.findAll(
    node =>
      Object.is(node.type, 'Button') &&
      node.findAll(child => child.props.children === label).length > 0
  );
  if (!found) {
    throw new Error(`missing ${label} button`);
  }
  return found;
}

export function saveButton(renderer: ReactTestRenderer): ReactTestInstance {
  return buttonByText(renderer, i18n.t('common.save'));
}

export function pressCancel(renderer: ReactTestRenderer): void {
  act(() => {
    (buttonByText(renderer, i18n.t('common.cancel')).props.onPress as () => void)();
  });
}

export async function pressSave(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    (saveButton(renderer).props.onPress as () => void)();
    await Promise.resolve();
  });
}

export function saveDisabled(renderer: ReactTestRenderer): boolean {
  return saveButton(renderer).props.disabled as boolean;
}

export function failureCopy(renderer: ReactTestRenderer): string | undefined {
  const status = renderer.root.findAllByType('AccessibleStatus')[0];
  const text = renderer.root.findAllByType('Text')[0];
  return (status?.props.message ?? text?.props.children) as string | undefined;
}
