// A profile's repository-default rows share one list, so each row must name
// itself and its own remove control: two rows announcing the same "Unbind" made
// a screen-reader user unable to tell them apart, and the row's parts were read
// after that control instead of before it.
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { RepoBindingRow } from '@/components/profiles/repo-bindings-rows';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  ICON_TARGET_BOX_CLASS,
} from '@/lib/a11y/tap-target';
import { type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  GitBranch: 'GitBranch',
  Trash2: 'Trash2',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));

const ROWS = [
  { repoFullName: 'acme/api', platform: 'github', profileName: 'Backend debugging' },
  { repoFullName: 'acme/infra', platform: 'gitlab', profileName: 'Infra' },
] as const;

function mountRows() {
  return renderWithProviders(
    createElement(
      'View',
      null,
      ...ROWS.map(row =>
        createElement(RepoBindingRow, {
          ...row,
          isRemoving: false,
          onRemove: vi.fn<() => void>(),
        })
      )
    )
  );
}

function identityLabels(root: ReactTestInstance): unknown[] {
  return root
    .findAll(node => node.props.accessibilityRole === 'text' && node.props.accessible === true)
    .map(node => node.props.accessibilityLabel);
}

function removeLabels(root: ReactTestInstance): unknown[] {
  return root
    .findAll(node => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'button')
    .map(node => node.props.accessibilityLabel);
}

describe('RepoBindingRow', () => {
  it('reads repository, profile and provider as one element per row', async () => {
    const { renderer, unmount } = await mountRows();

    expect(identityLabels(renderer.root)).toEqual([
      'acme/api, Backend debugging, GitHub',
      'acme/infra, Infra, GitLab',
    ]);

    unmount();
  });

  it('names each remove control after its own repository', async () => {
    const { renderer, unmount } = await mountRows();

    expect(removeLabels(renderer.root)).toEqual(['Unbind acme/api', 'Unbind acme/infra']);

    unmount();
  });

  it('keeps the provider badge out of the accessibility tree', async () => {
    const { renderer, unmount } = await mountRows();

    const badge = renderer.root.findAll(
      node => String(node.type) === 'Text' && node.props.children === 'GL'
    )[0];
    if (badge === undefined) {
      throw new Error('The provider badge did not render');
    }
    expect(badge.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(badge.props.accessibilityElementsHidden).toBe(true);

    unmount();
  });

  it('even the row insets with the compact remove box and its slop', async () => {
    const { renderer, unmount } = await mountRows();

    const remove = renderer.root
      .findAll(node => String(node.type) === 'Pressable')
      .find(node => node.props.accessibilityRole === 'button');
    if (!remove) {
      throw new Error('The remove control did not render');
    }
    // The row pads 16 dp on both sides and the glyph lands 16 dp from the end
    // edge: the compact 32 dp box pulls 7 dp toward the edge (`-me-[7px]`) and
    // centres the glyph in the remaining space, while the 8 dp slop keeps the
    // 48 dp touch reach inside the row Android clips touches to.
    expect(String(remove.props.className)).toContain(COMPACT_CONTROL_BOX_CLASS);
    expect(String(remove.props.className)).toContain('-me-[7px]');
    expect(String(remove.props.className)).not.toContain(ICON_TARGET_BOX_CLASS);
    expect(remove.props.hitSlop).toBe(COMPACT_CONTROL_HIT_SLOP_DP);

    unmount();
  });
});
