/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native accessibility regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

import { ManualReviewPlatformPicker } from './manual-review-platform-picker';

// The explorer finding (manual-review platform group, 2026-10-31) was a
// disabled platform radio named only by its platform, with its visible
// `Not connected` reason left outside the control: a screen reader heard the
// platform and its disabled state with no explanation. The reason now rides in
// the control's own name, and the row's visible copy is hidden from the
// accessibility tree so it is not read a second time.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/code-reviewer-config', () => ({
  PLATFORM_CAPABILITIES: { github: { label: 'GitHub' }, gitlab: { label: 'GitLab' } },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

type PickerProps = {
  isLoading?: boolean;
  platform: 'github' | 'gitlab';
  connected: readonly ('github' | 'gitlab')[];
};

function renderPicker({ isLoading = false, platform, connected }: PickerProps) {
  act(() => {
    const element = createElement(ManualReviewPlatformPicker, {
      isLoading,
      platform,
      isConnected: (option: 'github' | 'gitlab') => connected.includes(option),
      onSelect: () => undefined,
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing ManualReviewPlatformPicker renderer');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ManualReviewPlatformPicker accessible name', () => {
  it('names a connected option after its platform alone', () => {
    const [github] = renderPicker({ platform: 'github', connected: ['github', 'gitlab'] }).findAll(
      node => Object.is(node.type, 'Pressable')
    );

    expect(github?.props.accessibilityLabel).toBe('GitHub');
    expect(github?.props.accessibilityState).toMatchObject({ checked: true, disabled: false });
  });

  it('names a disabled option after its platform and the reason it cannot be chosen', () => {
    const [, gitlab] = renderPicker({ platform: 'github', connected: ['github'] }).findAll(node =>
      Object.is(node.type, 'Pressable')
    );

    // The visible reason used to be a sibling text outside the control, so a
    // screen reader never connected it with the option it explains.
    expect(gitlab?.props.accessibilityLabel).toBe(`GitLab, ${i18n.t('common.notConnected')}`);
    expect(gitlab?.props.accessibilityState).toMatchObject({ checked: false, disabled: true });
  });

  it('keeps the row copy out of the accessibility tree, so the reason is read once', () => {
    const [, gitlab] = renderPicker({ platform: 'github', connected: ['github'] }).findAll(node =>
      Object.is(node.type, 'Pressable')
    );

    const copies = gitlab?.findAll(
      node => Object.is(node.type, 'View') && node.props.importantForAccessibility !== undefined
    );
    expect(copies).toHaveLength(1);
    expect(copies?.[0]?.props).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    // The visible reason is still rendered for sighted users.
    expect(copies?.[0]?.findAll(node => Object.is(node.type, 'Text'))).toHaveLength(2);
  });

  it('keeps a checked option named by its platform, with no stale reason', () => {
    const [github, gitlab] = renderPicker({
      platform: 'gitlab',
      connected: ['github', 'gitlab'],
    }).findAll(node => Object.is(node.type, 'Pressable'));

    expect(github?.props.accessibilityLabel).toBe('GitHub');
    expect(gitlab?.props.accessibilityLabel).toBe('GitLab');
    expect(gitlab?.props.accessibilityState).toMatchObject({ checked: true, disabled: false });
  });

  it('dims the disabled label and never the reason it explains', () => {
    // A row-level opacity multiplied the muted token, which took the reason to
    // about 2:1 on the `bg-secondary` card. The dim is the label's own muted
    // token now, so the reason keeps the token's 4.5:1 in both themes.
    const [github, gitlab] = renderPicker({ platform: 'github', connected: ['github'] }).findAll(
      node => Object.is(node.type, 'Pressable')
    );

    expect(gitlab?.props.className).not.toContain('opacity-50');
    expect(github?.props.className).not.toContain('opacity-50');

    const [label, reason] = gitlab?.findAll(node => Object.is(node.type, 'Text')) ?? [];
    expect(label?.props.className).toContain('text-muted-foreground');
    expect(reason?.props.className).toBe('text-xs');
    expect(reason?.props.className).not.toContain('opacity');

    const [connectedLabel] = github?.findAll(node => Object.is(node.type, 'Text')) ?? [];
    expect(connectedLabel?.props.className).toBe('text-sm font-medium');
  });
});
