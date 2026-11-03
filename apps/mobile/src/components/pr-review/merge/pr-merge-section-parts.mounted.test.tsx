import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { AutoMergeEnabledBanner } from '@/components/pr-review/merge/pr-merge-section-parts';
import { type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * The auto-merge banner names the queued method inside a translated sentence.
 * The value it receives is the provider's code (`squash`), so this pins that the
 * sentence speaks the active catalog's method name instead of that code — the
 * defect a Pashto reader saw as `طریقه: squash`.
 */

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/icons', () => ({ RefreshCw: 'RefreshCw' }));
vi.mock('@/components/pr-review/merge/pr-merge-icons', () => ({
  mergeBlockedReasonIcon: () => 'BlockedReasonIcon',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#000000' }),
}));

async function renderBanner(method: string): Promise<ReactTestRenderer> {
  const { renderer } = await renderWithProviders(
    createElement(AutoMergeEnabledBanner, {
      method,
      onDisable: vi.fn<() => void>(),
      isDisabling: false,
    })
  );
  return renderer;
}

/** The banner draws the title, then the description, then the button's label. */
function renderedDescription(renderer: ReactTestRenderer): unknown {
  const rows = renderer.root.findAllByType('Text');
  const description = rows[1];
  if (!description) {
    throw new Error('banner rendered no description row');
  }
  return description.props.children;
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('AutoMergeEnabledBanner copy', () => {
  it('speaks the Pashto method name, not the wire code', async () => {
    await i18n.changeLanguage('ps');

    const renderer = await renderBanner('squash');
    const copy = renderedDescription(renderer);

    expect(copy).toBe(
      'کله چې ټولې اړینې ازموینې بریالۍ شي، GitHub به دا پل ریکویسټ په خپلکار ډول یوځای کړي (طریقه: د کمېټونو یو کول).'
    );
    expect(copy).not.toContain('squash');

    renderer.unmount();
  });

  it('speaks the English method name rather than the provider code', async () => {
    const renderer = await renderBanner('rebase');

    expect(renderedDescription(renderer)).toBe(
      'GitHub will merge this pull request automatically when all required checks pass (method: Rebase).'
    );

    renderer.unmount();
  });
});
