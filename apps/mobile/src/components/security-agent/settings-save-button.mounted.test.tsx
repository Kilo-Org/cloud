// The Security Agent settings header Save action is a variable-width header
// action. ScreenHeader sizes the trailing cluster to its content and never
// shrinks it (fixed-width actions must stay whole so the rightmost control is
// not cut off at the screen edge), so a label that grows with its copy has
// nothing to shrink against: the catalog "Save changes" is 28 glyphs in French,
// and an uncapped button consumed the row and left the flex-1 min-w-0 screen
// title at ~0 width on the narrowest 320 dp viewport. The action must bound
// itself at its source, exactly like PR review's Submit review.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsSaveButton } from './settings-save-button';

const routerState = vi.hoisted(() => ({ back: vi.fn() }));

vi.mock('expo-router', () => ({ useRouter: () => routerState }));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/ui/icons', () => ({ Loader2: 'Loader2' }));
vi.mock('@/lib/a11y/motion', () => ({ useMotionPolicy: () => ({ reducedMotion: false }) }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#fff', foreground: '#000' }),
}));
// Keep the real Button (its shrink-0 base and the `cn` merge are what this
// contract is about) and stub only the Text primitive, which needs a slot
// package that does not load under the DOM-free renderer.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return {
    Text: 'Text',
    TextClassContext: createContext<string | undefined>(undefined),
  };
});

type Instance = TestRenderer.ReactTestInstance;

function render(props: Partial<Parameters<typeof SettingsSaveButton>[0]> = {}) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SettingsSaveButton, {
        dirty: true,
        valid: true,
        pending: false,
        onSave: vi.fn().mockResolvedValue(undefined),
        skipNextGuardRef: { current: false },
        ...props,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function classes(node: Instance): string[] {
  return String(node.props.className ?? '')
    .split(/\s+/u)
    .filter(Boolean);
}

function findSavePressable(renderer: TestRenderer.ReactTestRenderer): Instance {
  return renderer.root.find(
    node => typeof node.type === 'string' && (node.type as string) === 'Pressable'
  );
}

function findLabel(renderer: TestRenderer.ReactTestRenderer): Instance {
  return renderer.root.find(
    node => typeof node.type === 'string' && (node.type as string) === 'Text'
  );
}

describe('SettingsSaveButton header cap', () => {
  beforeEach(() => {
    routerState.back.mockReset();
  });

  it('bounds the trailing action so the flex-1 screen title keeps room to draw', () => {
    const button = findSavePressable(render());

    const tokens = classes(button);
    // A variable-width header action caps itself on the narrowest viewport.
    expect(tokens).toContain('max-w-[140px]');
    expect(tokens).toContain('min-w-0');
    // The Button's own `shrink-0` must be overridden or the cap would clip the
    // label instead of letting it compress.
    expect(tokens).toContain('shrink');
    expect(tokens).not.toContain('shrink-0');
  });

  it('lets the label compress and wrap inside the cap instead of clipping', () => {
    const label = findLabel(render());

    expect(classes(label)).toContain('shrink');
    // No line limit: the label wraps in place rather than ellipsizing, so a
    // long catalog translation stays readable.
    expect(label.props.numberOfLines).toBeUndefined();
  });

  it('still saves and pops the screen when the button is pressed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const renderer = render({ onSave });

    act(() => {
      (findSavePressable(renderer).props.onPress as () => void)();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledOnce();
    expect(routerState.back).toHaveBeenCalledOnce();
  });
});
