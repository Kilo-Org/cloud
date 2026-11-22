import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SheetFocusSink } from './sheet-focus-sink';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

/**
 * The sink exists so a presented sheet's opening focus lands on it rather than
 * on the first read-only value, whose selectable `Text` would then paint the
 * platform's focus layer as a strip inside its field. Two properties make that
 * work, and both are easy to break by accident:
 *
 * - it must be `selectable`, because a sheet window opens in touch mode and only
 *   a focusable-in-touch-mode node takes the focus there;
 * - it must paint nothing and take no reader, so it never shows up as a strip of
 *   its own or as an unnamed focus stop.
 */
describe('SheetFocusSink', () => {
  it('takes touch-mode focus as a selectable text node that paints nothing', async () => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      await Promise.resolve();
      ref.current = TestRenderer.create(<SheetFocusSink />);
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    const [sink] = renderer.root.findAll(node => (node.type as unknown) === 'Text');
    if (!sink) {
      throw new Error('sink was not rendered');
    }
    const props: Record<string, unknown> = sink.props;
    expect(props.selectable).toBe(true);
    // A transparent one-pixel box out of the content flow: nothing to see, and
    // no layout the sheet's content could inherit.
    expect((props.className as string).split(' ')).toEqual(
      expect.arrayContaining(['absolute', 'size-px', 'opacity-0'])
    );
    // Hidden from both readers, so neither announces an unnamed control.
    expect(props['aria-hidden']).toBe(true);
    expect(props.importantForAccessibility).toBe('no-hide-descendants');
    // It carries no copy, so nothing can be selected or copied out of it.
    expect(props.children).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
