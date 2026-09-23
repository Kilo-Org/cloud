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

/** The Text lines rendered inside a node, flattened (composed lines arrive as arrays). */
function linesOf(node: ReactTestInstance): string[] {
  return node
    .findAll(child => typeof child.type === 'string' && (child.type as string) === 'Text')
    .map(child => [child.props.children].flat().join(''));
}

/** The View that carries the `Feature flags` group label. */
function headerRow(tree: ReactTestRenderer): ReactTestInstance {
  const label = tree.root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      [node.props.children].flat().join('') === 'Feature flags'
  );
  const header = label.parent;
  if (!header) {
    throw new Error('Feature flags label has no parent View');
  }
  return header;
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

  it('renders the build version on the group header line, not as a stray label', async () => {
    posthog.statuses = [applied];
    const tree = await mount();

    // The version rides the group's own label: the View carrying the
    // `Feature flags` header also carries the `v1.0.5` version Text.
    const header = headerRow(tree);
    expect(header.type).toBe('View');
    expect(linesOf(header)).toEqual(['Feature flags', 'v1.0.5']);

    // The section's last child is the flags list, so no label hangs below it.
    const section = header.parent;
    if (!section) {
      throw new Error('Feature flags header has no parent View');
    }
    const last = section.children.at(-1);
    if (typeof last === 'string' || last === undefined) {
      throw new Error('Feature flags section has no trailing View');
    }
    expect(String(last.type)).toBe('View');
    expect(linesOf(last)).toContain('mobile-pr-review');
    expect(linesOf(last)).not.toContain('v1.0.5');
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
