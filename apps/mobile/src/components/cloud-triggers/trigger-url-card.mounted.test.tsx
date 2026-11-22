/**
 * The trigger detail's URL card: the address, and a copy control a finger can
 * reach.
 *
 * The copy control is the shared compact box, which is smaller than the
 * platform's touch target. It declares the rest of its reach through `hitSlop`,
 * and React Native clips that reach at the parent view. The host asserted here
 * is that parent: it carries the platform target on both axes, so the declared
 * reach is delivered. A control mounted against a shorter parent would pass a
 * control-size audit and still lose most of its touch area.
 */

import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  textActionTargetClass,
} from '@/lib/a11y/tap-target';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerUrlCard } from './trigger-url-card';

const URL = 'https://inbound.example/trigger-a';

const copyWebhookUrl = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  // `textActionTargetClass` reads the platform to pick the shared frame.
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android },
}));
vi.mock('@/lib/cloud-triggers/copy-webhook-url', () => ({ copyWebhookUrl }));
vi.mock('@/components/ui/icons', () => ({ Copy: 'Copy' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => new Proxy({}, { get: () => '#000000' }),
}));

const PRESSABLE = 'Pressable' as ElementType;
const TEXT = 'Text' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount(): Promise<ReactTestInstance> {
  const view = await renderWithProviders(createElement(TriggerUrlCard, { url: URL }));
  renderer = view.renderer;
  return view.renderer.root;
}

function copyControl(root: ReactTestInstance): ReactTestInstance {
  const [control] = root.findAll(
    node =>
      Object.is(node.type, PRESSABLE) && node.props.accessibilityLabel === i18n.t('common.copyLink')
  );
  if (!control) {
    throw new Error('missing copy control');
  }
  return control;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  copyWebhookUrl.mockClear();
});

describe('TriggerUrlCard copy control', () => {
  it('renders the URL beside a copy control hosted at the platform target', async () => {
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, TEXT)).map(node => node.props.children)
    ).toContain(URL);

    const control = copyControl(root);
    // The control keeps the compact box and declares its reach as slop.
    expect(String(control.props.className).split(' ')).toEqual(
      expect.arrayContaining(COMPACT_CONTROL_BOX_CLASS.split(' '))
    );
    expect(control.props.hitSlop).toBe(COMPACT_CONTROL_HIT_SLOP_DP);

    // The host is the control's parent, so it is the view React Native clips
    // the slop at: it must carry the platform target on both axes.
    const host = control.parent;
    if (!host) {
      throw new Error('copy control has no host');
    }
    expect(String(host.props.className).split(' ')).toEqual(
      expect.arrayContaining([...textActionTargetClass().split(' '), 'shrink-0'])
    );
  });

  it('copies the URL when the control is pressed', async () => {
    const root = await mount();

    act(() => {
      (copyControl(root).props.onPress as () => void)();
    });

    expect(copyWebhookUrl).toHaveBeenCalledWith(URL);
  });
});
