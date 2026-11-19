import { Effect, Fiber } from 'effect';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsConfirmHost } from '@/components/settings-confirm-host';
import { act, type TestRenderer } from '@/test/renderer';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

import {
  answerSettingsConfirm,
  confirmSettingChange,
  getSettingsConfirmRequest,
  setSettingsConfirmHostMounted,
  settleAllSettingsConfirms,
} from './confirm';

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 2 }),
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => new Proxy({}, { get: () => '#000000' }),
}));

const SUMMARY = 'Change "trustedHosts" to ["a"]';

let mounted: RenderWithProvidersResult | undefined = undefined;

async function mountHost(): Promise<RenderWithProvidersResult> {
  mounted = await renderWithProviders(createElement(SettingsConfirmHost, null));
  return mounted;
}

function isType(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && node.type === type;
}

function textNodes(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAll(node => isType(node, 'Text') && node.children.includes(text));
}

function pressableWith(renderer: TestRenderer.ReactTestRenderer, token: string) {
  return renderer.root.find(node => {
    const className = node.props.className;
    return isType(node, 'Pressable') && typeof className === 'string' && className.includes(token);
  });
}

/**
 * Calls one of a mounted element's own props inside `act`. The test renderer
 * leaves `props` untyped, and this suite only calls the handlers it would
 * otherwise press by hand.
 */
function callProp(node: TestRenderer.ReactTestInstance, name: string): void {
  const prop = node.props[name] as (() => void) | undefined;
  if (typeof prop !== 'function') {
    throw new TypeError(`The element has no callable ${name}`);
  }
  act(() => {
    prop();
  });
}

/** Presses a dialog choice, then reports the finished native dismissal. */
function choose(renderer: TestRenderer.ReactTestRenderer, token: string): void {
  callProp(pressableWith(renderer, token), 'onPress');
  callProp(
    renderer.root.find(node => isType(node, 'BottomSheet')),
    'onDismiss'
  );
}

beforeEach(() => {
  settleAllSettingsConfirms(false);
  setSettingsConfirmHostMounted(false);
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  settleAllSettingsConfirms(false);
  setSettingsConfirmHostMounted(false);
});

describe('confirmSettingChange', () => {
  it('draws the summary and resolves true when the person saves', async () => {
    const view = await mountHost();
    const pending = Effect.runPromise(confirmSettingChange(SUMMARY));

    await waitFor(() => textNodes(view.renderer, SUMMARY).length === 1);
    expect(textNodes(view.renderer, 'Confirm this change?')).toHaveLength(1);

    choose(view.renderer, 'bg-destructive');

    await expect(pending).resolves.toBe(true);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });

  it('resolves false when the person cancels', async () => {
    const view = await mountHost();
    const pending = Effect.runPromise(confirmSettingChange(SUMMARY));

    await waitFor(() => textNodes(view.renderer, SUMMARY).length === 1);
    choose(view.renderer, 'border-border');

    await expect(pending).resolves.toBe(false);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });

  it('shows a second request only after the first is answered', async () => {
    const view = await mountHost();
    const first = Effect.runPromise(confirmSettingChange(SUMMARY));
    const second = Effect.runPromise(confirmSettingChange('Change "theme" to "dark"'));

    await waitFor(() => textNodes(view.renderer, SUMMARY).length === 1);
    expect(textNodes(view.renderer, 'Change "theme" to "dark"')).toHaveLength(0);

    choose(view.renderer, 'bg-destructive');
    await expect(first).resolves.toBe(true);

    await waitFor(() => textNodes(view.renderer, 'Change "theme" to "dark"').length === 1);
    expect(textNodes(view.renderer, SUMMARY)).toHaveLength(0);

    choose(view.renderer, 'border-border');
    await expect(second).resolves.toBe(false);
  });

  it('removes the dialog when the request is interrupted', async () => {
    const view = await mountHost();
    const fiber = Effect.runFork(confirmSettingChange(SUMMARY));

    await waitFor(() => getSettingsConfirmRequest() !== undefined);
    const id = getSettingsConfirmRequest()?.id;
    expect(id).toBeDefined();

    await Effect.runPromise(Fiber.interrupt(fiber));

    await waitFor(() => getSettingsConfirmRequest() === undefined);
    expect(textNodes(view.renderer, SUMMARY)).toHaveLength(0);

    // A late answer for the withdrawn request has nothing left to settle.
    if (id !== undefined) {
      answerSettingsConfirm(id, true);
    }
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });
});
