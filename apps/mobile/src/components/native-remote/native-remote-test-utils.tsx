import { type NativePendingRequests, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { createElement, Fragment, type ReactNode, type Ref, useImperativeHandle } from 'react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { NativeRemoteDemo } from './native-remote-demo';
import { type NativeRemoteClient } from '@/lib/native-remote/use-native-inventory';
import { useOpenPartDetail } from '@/components/agents/open-part-detail-context';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({ View: 'View', Keyboard: { dismiss: vi.fn() } }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/input', () => ({
  Input: function Input({ ref, ...props }: { ref?: Ref<{ clear: () => void }> }) {
    useImperativeHandle(ref, () => ({ clear: vi.fn() }));
    return createElement('Input', props);
  },
}));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/agents/message-bubble', () => ({
  MessageBubble: ({ message, ...props }: { message: StoredMessage }) => {
    const openToolDetail = useOpenPartDetail();
    return createElement(
      'MessageBubble',
      { message, ...props },
      message.parts.map(part => (part.type === 'text' ? part.text : '')).join(' '),
      message.parts
        .filter(part => part.type === 'tool')
        .map(part =>
          createElement(
            'Button',
            {
              key: part.id,
              disabled: openToolDetail === null,
              onPress: () => {
                openToolDetail?.(part.id);
              },
            },
            `Open ${part.tool} details`
          )
        )
    );
  },
}));
vi.mock('@/components/agents/part-detail-sheet', () => ({
  PartDetailSheet: (props: object) => createElement('PartDetailSheet', props),
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: function FlashList({
    data,
    keyExtractor,
    renderItem,
  }: {
    data: unknown[];
    keyExtractor: (item: unknown) => string;
    renderItem: (info: { item: unknown }) => ReactNode;
  }) {
    return createElement(
      'FlashList',
      {},
      data.map(item => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item })))
    );
  },
}));

const renderers: TestRenderer.ReactTestRenderer[] = [];
export async function flush() {
  const pending = Promise.withResolvers<undefined>();
  setTimeout(pending.resolve, 0);
  await pending.promise;
}
export async function mount(client: NativeRemoteClient, organizationID?: string) {
  const created: ReactTestRenderer[] = [];
  await act(async () => {
    created.push(
      TestRenderer.create(<NativeRemoteDemo client={client} organizationID={organizationID} />)
    );
    await flush();
  });
  const renderer = created.at(0);
  if (!renderer) {
    throw new Error('Demo did not mount');
  }
  renderers.push(renderer);
  return renderer;
}
export function text(node: ReactTestInstance): string {
  return node.children.map(child => (typeof child === 'string' ? child : text(child))).join(' ');
}
export function button(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType('Button')
    .find(candidate => text(candidate).includes(label));
  if (!node) {
    throw new Error(`Button not found: ${label}`);
  }
  return node;
}
export async function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  await act(async () => {
    const props = button(renderer, label).props as { onPress: () => void; disabled?: boolean };
    expect(props.disabled).not.toBe(true);
    props.onPress();
    await flush();
  });
}
export async function type(renderer: TestRenderer.ReactTestRenderer, label: string, value: string) {
  await act(() => {
    const props = renderer.root.findByProps({ accessibilityLabel: label }).props as {
      onChangeText: (value: string) => void;
      value?: string;
    };
    expect(props.value).toBeUndefined();
    props.onChangeText(value);
  });
}
export function inventoryPending(): NativePendingRequests {
  return {
    permissions: [{ id: 'permission', action: 'shell', resources: ['Run tests'] }],
    questions: [
      {
        id: 'question',
        metadata: { kind: 'question' },
        fields: [{ key: 'answer', title: 'Your choice', type: 'text' }],
      },
    ],
  };
}
beforeEach(() => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
});
