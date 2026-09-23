import { createElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { FeatureFlagsSection } from '@/components/feature-flags-section';
import { renderWithProviders } from '@/test/render-with-providers';

vi.hoisted(() => {
  vi.stubGlobal('__DEV__', true);
});
/** Statuses the mocked PostHog module reports; each test seeds this. */
const posthog = vi.hoisted(() => ({
  statuses: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/analytics/posthog', () => ({
  useFeatureFlagStatuses: () => posthog.statuses,
}));

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function flush(): Promise<void> {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}
async function mount(): Promise<ReactTestRenderer> {
  view = await renderWithProviders(createElement(FeatureFlagsSection));
  await flush();
  return view.renderer;
}

/** All rendered Text strings, flattened (composed lines arrive as arrays). */
function textLines(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => [node.props.children].flat().join(''));
}

/** The Text node whose flattened content is exactly `content`. */
function textNode(tree: ReactTestRenderer, content: string): ReactTestInstance {
  const [node] = tree.root.findAll(
    candidate =>
      typeof candidate.type === 'string' &&
      (candidate.type as string) === 'Text' &&
      [candidate.props.children].flat().join('') === content
  );
  if (!node) {
    throw new Error(`No Text rendered "${content}"`);
  }
  return node;
}

/** The flattened text of `node`'s direct children. */
function childText(node: ReactTestInstance): string[] {
  return node.children
    .filter((child): child is ReactTestInstance => typeof child !== 'string')
    .map(child => [child.props.children].flat().join(''));
}

/** Whether `ancestor` sits above `node` in the rendered tree. */
function contains(ancestor: ReactTestInstance, node: ReactTestInstance): boolean {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (cursor === ancestor) {
      return true;
    }
  }
  return false;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', true);
  posthog.statuses = [];
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

const applied = {
  key: 'mobile-pr-review',
  minAppVersion: '1.0.4',
  defaultValue: true,
  appVersion: '1.0.5',
  applied: true,
  value: true,
  reason: 'applied',
  loaded: true,
};
const skipped = {
  key: 'mobile-quick-chat',
  minAppVersion: '1.0.6',
  defaultValue: false,
  appVersion: '1.0.5',
  applied: false,
  value: false,
  reason: 'build-too-old',
  loaded: true,
};
const unloaded = {
  key: 'mobile-pr-review',
  minAppVersion: '1.0.4',
  defaultValue: true,
  appVersion: '1.0.8',
  applied: false,
  value: true,
  reason: 'applied',
  loaded: false,
};

describe('FeatureFlagsSection', () => {
  it('lists every flag with the value the build acts on and why', async () => {
    posthog.statuses = [applied, skipped];
    const tree = await mount();

    const lines = textLines(tree);
    expect(lines).toContain('Feature flags');
    expect(lines).toContain('mobile-pr-review');
    expect(lines).toContain('Enabled · remote · ≥ 1.0.4');
    expect(lines).toContain('mobile-quick-chat');
    expect(lines).toContain('Off · default · < 1.0.6');
    expect(lines).toContain('v1.0.5');
  });

  it('marks a flag the build skips as default in use with the minimum version', async () => {
    posthog.statuses = [skipped];
    const tree = await mount();

    expect(textLines(tree)).toContain('Off · default · < 1.0.6');
  });

  it('marks an applied flag as remote value in use', async () => {
    posthog.statuses = [applied];
    const tree = await mount();

    expect(textLines(tree)).toContain('Enabled · remote · ≥ 1.0.4');
  });

  it('marks defaults in use while remote flags are not loaded yet', async () => {
    posthog.statuses = [unloaded];
    const tree = await mount();

    expect(textLines(tree)).toContain('Enabled · default · not loaded');
  });

  it('marks a below-minimum flag with the version gate even before remote flags load', async () => {
    // The staged v1.0.5 case: the gate is decided by the app version alone, so
    // the row must read "< 1.0.6" whether or not PostHog ever returned a value.
    posthog.statuses = [{ ...skipped, loaded: false }];
    const tree = await mount();

    expect(textLines(tree)).toContain('Off · default · < 1.0.6');
  });

  it('keeps the build string on the section label row, not as a list entry', async () => {
    posthog.statuses = [applied, skipped];
    const tree = await mount();

    const label = textNode(tree, 'Feature flags');
    const build = textNode(tree, 'v1.0.5');
    const row = label.parent;
    if (!row) {
      throw new Error('The section label is not rendered inside a row');
    }

    // The section label and the build string share one row...
    expect(build.parent).toBe(row);
    // ...laid out at its two ends rather than stacked...
    const rowClasses = String(row.props.className ?? '');
    expect(rowClasses).toContain('flex-row');
    expect(rowClasses).toContain('items-baseline');
    expect(rowClasses).toContain('justify-between');
    // ...holding exactly those two labels, so no flag row can join them.
    expect(childText(row)).toEqual(['Feature flags', 'v1.0.5']);

    // The version is not an entry of the flag list.
    const flagList = textNode(tree, 'mobile-pr-review').parent?.parent;
    if (!flagList) {
      throw new Error('The flag list container is not rendered');
    }
    expect(contains(flagList, build)).toBe(false);
  });

  it('renders nothing when the registry is empty', async () => {
    posthog.statuses = [];
    const tree = await mount();

    expect(textLines(tree)).toEqual([]);
  });

  it('renders nothing outside development', async () => {
    vi.stubGlobal('__DEV__', false);
    posthog.statuses = [applied];
    const tree = await mount();

    expect(textLines(tree)).toEqual([]);
  });
});
