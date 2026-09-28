import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BootstrapLoadingSurface } from '@/components/bootstrap-loading-surface';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/../assets/images/logo.png', () => ({ default: 1 }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#71717a' }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

async function mountSurface(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(BootstrapLoadingSurface));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BootstrapLoadingSurface', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('renders one spinner in a progressbar surface covering the screen', async () => {
    const renderer = await mountSurface();

    const surface = renderer.root.findByProps({ accessibilityRole: 'progressbar' });
    expect(surface.props.accessibilityLabel).toBe('common.loading');
    expect(surface.props.accessibilityState).toEqual({ busy: true });
    expect(surface.props.className).toContain('absolute inset-0');
    expect(surface.props.className).toContain('bg-background');

    // One indicator, not a stack: the surface owns the whole wait.
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'ActivityIndicator'
      )
    ).toHaveLength(1);

    renderer.unmount();
  });

  it('draws the Kilo brand mark and the loading label, not only a spinner', async () => {
    const renderer = await mountSurface();

    // The sign-in screen's mark: a bare spinner read as an unbranded blank
    // page (explorer signin-language).
    const logo = renderer.root.findByType('Image');
    expect(logo.props.source).toBe(1);
    expect(logo.props.accessibilityLabel).toBe('login.logo');

    // The wait is named, not left to a wordless spinner.
    const labels = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.children === 'common.loading'
    );
    expect(labels).toHaveLength(1);

    renderer.unmount();
  });
});
