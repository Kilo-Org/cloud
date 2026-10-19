// The instructions editor's text field must expose the screen's own localized
// name ("Custom instructions") instead of the platform's generic "Text view",
// which told a screen-reader user nothing about what to type.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import InstructionsRoute from './instructions';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());
const useReviewConfigMock = vi.hoisted(() => vi.fn());
const useSaveReviewConfigMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
  useRouter: () => ({ back: vi.fn() }),
}));

vi.mock('react-native', () => ({
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: {},
}));

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useReviewConfig: useReviewConfigMock,
  useSaveReviewConfig: useSaveReviewConfigMock,
}));

function mountRoute(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(InstructionsRoute));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

beforeEach(() => {
  useLocalSearchParamsMock.mockReset().mockReturnValue({ scope: 'personal', platform: 'github' });
  useReviewConfigMock.mockReset().mockReturnValue({
    data: { customInstructions: 'Enforce our error-handling conventions.' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  useSaveReviewConfigMock.mockReset().mockReturnValue({ mutate: vi.fn(), isPending: false });
});

describe('InstructionsRoute editor field', () => {
  it('labels the editor with the localized instructions title', () => {
    const renderer = mountRoute();

    const editors = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'TextInput'
    );
    expect(editors).toHaveLength(1);
    expect(editors[0]?.props.accessibilityLabel).toBe('Custom instructions');

    act(() => {
      renderer.unmount();
    });
  });

  it('follows the active catalog instead of an English literal', async () => {
    await i18n.changeLanguage('ar');
    const renderer = mountRoute();

    const editors = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'TextInput'
    );
    expect(editors[0]?.props.accessibilityLabel).toBe(i18n.t('codeReviewer.instructions.title'));
    expect(editors[0]?.props.accessibilityLabel).not.toBe('Custom instructions');

    act(() => {
      renderer.unmount();
    });
  });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});
