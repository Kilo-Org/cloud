import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';

import { FixedPartRow } from './fixed-part-row';
import { MessageLongPressContext } from './message-long-press-context';

type RowProps = Parameters<typeof FixedPartRow>[0];

export async function renderRowInContext(
  props: RowProps,
  messageLongPress?: () => void
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  const element = messageLongPress
    ? createElement(
        MessageLongPressContext.Provider,
        { value: messageLongPress },
        createElement(FixedPartRow, props)
      )
    : createElement(FixedPartRow, props);
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(element);
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

export async function renderRow(props: RowProps): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(FixedPartRow, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

export function findHost(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

/** The inner row that carries the label and, when present, the badge. */
export function findContentRow(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance {
  const row = findHost(root, 'View').find(
    node =>
      typeof node.props.className === 'string' &&
      node.props.className.includes('flex-1') &&
      node.props.className.includes('flex-row')
  );
  if (!row) {
    throw new Error('label/badge content row not found');
  }
  return row;
}

export function textWithContent(
  root: TestRenderer.ReactTestInstance,
  content: string
): TestRenderer.ReactTestInstance[] {
  return findHost(root, 'Text').filter(node => node.props.children === content);
}
