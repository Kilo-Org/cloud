import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

import { SharePrefillFailure } from './share-prefill-failure';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type Renderer = TestRenderer.ReactTestRenderer;

async function mount(onRetry: () => void, onDismiss: () => void): Promise<Renderer> {
  const ref: { current: Renderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      <SharePrefillFailure onRetry={onRetry} onDismiss={onDismiss} />
    );
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

function pressables(renderer: Renderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAllByType('Pressable' as never);
}

function press(control: TestRenderer.ReactTestInstance | undefined): void {
  if (!control) {
    throw new Error('control did not render');
  }
  const onPress = control.props.onPress as () => void;
  onPress();
}

describe('SharePrefillFailure', () => {
  it('names the failure and offers retry and discard with existing copy', async () => {
    const renderer = await mount(vi.fn<() => void>(), vi.fn<() => void>());

    const texts = renderer.root
      .findAll(node => Object.is(node.type, 'Text'))
      .map(node => String(node.props.children));
    expect(texts).toEqual([
      i18n.t('chat.attachment.attachFailed'),
      i18n.t('common.retry'),
      i18n.t('common.remove'),
    ]);

    const [retry, dismiss] = pressables(renderer);
    expect(retry).toBeDefined();
    expect(dismiss).toBeDefined();
    expect(retry?.props.accessibilityLabel).toBe(i18n.t('common.retry'));
    expect(dismiss?.props.accessibilityLabel).toBe(i18n.t('common.remove'));
    expect(pressables(renderer)).toHaveLength(2);
  });

  it('runs the handlers it is given', async () => {
    const onRetry = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const renderer = await mount(onRetry, onDismiss);
    const [retry, dismiss] = pressables(renderer);
    act(() => {
      press(retry);
      press(dismiss);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
