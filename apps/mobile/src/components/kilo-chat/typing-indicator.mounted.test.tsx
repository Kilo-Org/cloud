import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TypingIndicator } from './typing-indicator';

const keyboard = vi.hoisted(() => ({ isVisible: false }));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('expo-screen-corner-radius', () => ({ getCornerRadiusSync: () => 60 }));
vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: (selector: (state: { isVisible: boolean }) => boolean) => selector(keyboard),
}));

function mount(typingMembers: Map<string, number>) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(TypingIndicator, { typingMembers }));
  });
  if (!ref.current) {
    throw new Error('typing indicator was not mounted');
  }
  return ref.current;
}

describe('typing indicator layout', () => {
  beforeEach(() => {
    keyboard.isVisible = false;
  });

  it.each([false, true])('reserves no empty row with keyboard visibility %s', isVisible => {
    keyboard.isVisible = isVisible;
    const renderer = mount(new Map());

    expect(renderer.toJSON()).toBeNull();

    renderer.unmount();
  });

  it('hides the row when the last typing member leaves', () => {
    const renderer = mount(new Map([['bot:sandbox-1', 1]]));

    act(() => {
      renderer.update(createElement(TypingIndicator, { typingMembers: new Map() }));
    });
    expect(renderer.toJSON()).toBeNull();

    renderer.unmount();
  });
});
