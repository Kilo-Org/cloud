import { type ComponentProps, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileSectionHeader } from '@/components/profiles/profile-section-header';
import { act, TestRenderer } from '@/test/renderer';

const h = vi.hoisted(() => ({
  overview: {
    data: undefined as { name: string } | undefined,
  },
  back: vi.fn(),
  canGoBack: vi.fn(() => true),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: h.back, canGoBack: h.canGoBack }),
  useNavigationContainerRef: () => ({ addListener: () => () => undefined }),
}));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 800, fontScale: 1 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000' }),
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileOverview: () => h.overview,
}));

function renderHeader(
  props: ComponentProps<typeof ProfileSectionHeader>
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(ProfileSectionHeader, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** The header's text lines, in the order the heading renders them. */
function headerLines(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => String(node.props.children));
}

describe('ProfileSectionHeader mounted', () => {
  beforeEach(() => {
    h.overview.data = undefined;
    h.back.mockReset();
    h.canGoBack.mockReturnValue(true);
  });

  it('names the profile under the section title once the profile is read', () => {
    h.overview.data = { name: 'Shared Agency Review Profile' };
    const renderer = renderHeader({
      profileId: 'profile-1',
      organizationId: 'org-1',
      title: 'Profile agents',
    });

    expect(headerLines(renderer)).toEqual(['Profile agents', 'Shared Agency Review Profile']);
    renderer.unmount();
  });

  it('holds the subtitle line while the profile read is unsettled', () => {
    const renderer = renderHeader({ profileId: 'profile-1', title: 'Skills' });

    // The reserved line is the same style as the name that replaces it, so the
    // header keeps its height instead of growing when the name arrives.
    expect(headerLines(renderer)).toEqual(['Skills', '\u00A0']);
    renderer.unmount();
  });

  it('keeps the caller Back press', () => {
    const onBack = vi.fn<() => void>();
    const renderer = renderHeader({
      profileId: 'profile-1',
      title: 'Setup commands',
      onBack,
    });

    const back = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Go back'
    );
    act(() => {
      (back.props.onPress as () => void)();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(h.back).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
