import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SheetFocusSink } from './sheet-focus-sink';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

/**
 * The sink exists so a presented sheet's opening focus lands on it rather than
 * on the first read-only value, whose selectable `Text` would then paint the
 * platform's focus layer as a strip inside its field. Three properties make that
 * work, and each is easy to break by accident:
 *
 * - the text must be `selectable`, because a sheet window opens in touch mode
 *   and only a focusable-in-touch-mode node takes the focus there;
 * - the wrapper must refuse the touch, because `selectable` also makes a native
 *   text view clickable and a `Text` has no `pointerEvents` prop of its own;
 * - both must paint nothing and take no reader, so the sink is neither a strip
 *   of its own nor an unnamed focus stop.
 */
describe('SheetFocusSink', () => {
  it('takes touch-mode focus on a selectable text and refuses the touch above it', async () => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      await Promise.resolve();
      ref.current = TestRenderer.create(<SheetFocusSink />);
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    const [wrapper] = renderer.root.findAll(node => (node.type as unknown) === 'View');
    const [sink] = renderer.root.findAll(node => (node.type as unknown) === 'Text');
    if (!wrapper || !sink) {
      throw new Error('the sink was not rendered');
    }
    const wrapperProps: Record<string, unknown> = wrapper.props;
    const textProps: Record<string, unknown> = sink.props;

    expect(textProps.selectable).toBe(true);
    // The wrapper is what the platform reads for pointer events: `ReactTextView`
    // is not a `ReactPointerEventsView`, so a `pointerEvents` on the text itself
    // would be ignored.
    expect(wrapperProps.pointerEvents).toBe('none');
    expect(textProps.pointerEvents).toBeUndefined();
    expect(wrapperProps['aria-hidden']).toBe(true);
    expect(wrapperProps.importantForAccessibility).toBe('no-hide-descendants');
    // A transparent one-pixel box out of the content flow: nothing to see, and
    // no layout the sheet's content could inherit.
    expect((wrapperProps.className as string).split(' ')).toEqual(
      expect.arrayContaining(['absolute', 'size-px'])
    );
    expect((textProps.className as string).split(' ')).toContain('opacity-0');
    // It carries no copy, so nothing can be selected or copied out of it.
    expect(textProps.children).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
