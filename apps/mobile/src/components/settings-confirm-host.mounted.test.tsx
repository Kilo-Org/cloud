import { Effect, Fiber } from 'effect';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  confirmSettingChange,
  getSettingsConfirmRequest,
  requestSettingsConfirmChange,
  setSettingsConfirmHostMounted,
  settleAllSettingsConfirms,
} from '@/lib/settings/confirm';
import { act, type TestRenderer } from '@/test/renderer';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

import { SettingsConfirmHost } from './settings-confirm-host';

vi.mock('react-native', () => ({
  // Sheet registers the app-level Android Back listener while it is visible.
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

/** The sheet the dialog presents, for driving the mock's own props. */
function bottomSheet(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(node => isType(node, 'BottomSheet'));
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

describe('SettingsConfirmHost', () => {
  it('renders nothing while no request is pending', async () => {
    const view = await mountHost();

    expect(view.renderer.toJSON()).toBeNull();
    expect(view.renderer.root.findAll(node => isType(node, 'BottomSheet'))).toHaveLength(0);
  });

  it('renders the shipped dialog copy for a pending request', async () => {
    const view = await mountHost();

    act(() => {
      requestSettingsConfirmChange(SUMMARY, () => undefined);
    });

    await waitFor(() => textNodes(view.renderer, SUMMARY).length === 1);
    expect(textNodes(view.renderer, 'Confirm this change?')).toHaveLength(1);
    expect(textNodes(view.renderer, 'Save')).toHaveLength(1);
    expect(textNodes(view.renderer, 'Cancel')).toHaveLength(1);
  });

  // The one mount-based wiring proof: a pending tool call raises the dialog on
  // the real store, the person's Save runs through the host into the store, and
  // the waiting call resolves true only after the sheet has reported.
  it('resolves a pending call true when the person saves', async () => {
    const view = await mountHost();
    const pending = Effect.runPromise(confirmSettingChange(SUMMARY));

    await waitFor(() => textNodes(view.renderer, SUMMARY).length === 1);
    expect(textNodes(view.renderer, 'Confirm this change?')).toHaveLength(1);

    const save = view.renderer.root.find(
      node =>
        isType(node, 'Pressable') &&
        typeof node.props.className === 'string' &&
        node.props.className.includes('bg-destructive')
    );
    act(() => {
      const onPress = save.props.onPress as (() => void) | undefined;
      onPress?.();
    });

    // The choice starts the dismissal before the answer lands; the sheet's
    // mock reports the finished dismissal.
    act(() => {
      (bottomSheet(view.renderer).props.onDismiss as (() => void) | undefined)?.();
    });

    await expect(pending).resolves.toBe(true);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });

  it('settles a pending request false when the host unmounts', async () => {
    const view = await mountHost();
    const pending = Effect.runPromise(confirmSettingChange(SUMMARY));

    await waitFor(() => getSettingsConfirmRequest() !== undefined);
    view.unmount();
    mounted = undefined;

    await expect(pending).resolves.toBe(false);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });

  it('refuses a request when no host is mounted', async () => {
    await expect(Effect.runPromise(confirmSettingChange(SUMMARY))).resolves.toBe(false);
    expect(getSettingsConfirmRequest()).toBeUndefined();
    expect(mounted).toBeUndefined();
  });

  // An interrupted call's request stays drawn — the sheet may not unmount
  // mid-presentation — and no choice reaches it. Once the sheet reports its
  // dismissal, the host removes the withdrawn request from the queue.
  it('draws a withdrawn request until its sheet reports, then forgets it', async () => {
    const view = await mountHost();
    const fiber = Effect.runFork(confirmSettingChange(SUMMARY));

    await waitFor(() => textNodes(view.renderer, SUMMARY).length === 1);

    await Effect.runPromise(Fiber.interrupt(fiber));

    // Withdrawn, still drawn — the sheet is not pulled out under the person.
    expect(getSettingsConfirmRequest()).toMatchObject({ withdrawn: true });
    expect(textNodes(view.renderer, SUMMARY)).toHaveLength(1);

    // The sheet reports its dismissal and the host forgets the request.
    act(() => {
      const report = bottomSheet(view.renderer).props.onDismiss as (() => void) | undefined;
      report?.();
    });

    expect(getSettingsConfirmRequest()).toBeUndefined();
    expect(view.renderer.toJSON()).toBeNull();
  });
});
