import { Effect, Fiber } from 'effect';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  confirmSettingChange,
  getSettingsConfirmRequest,
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

const FIRST = 'Change "trustedHosts" to ["a"]';
const SECOND = 'Change "theme" to "dark"';

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
  return renderer.root.find(
    node =>
      isType(node, 'Pressable') &&
      typeof node.props.className === 'string' &&
      node.props.className.includes(token)
  );
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
  // The dishonored press: the person cancels, the sheet hands its stay-over
  // report to the cancel answer captured before the tool call was interrupted,
  // and the withdrawal lands between the two. The report then runs the stale
  // closure, whose delivered answer must still free the queue entry — or the
  // withdrawn head stays drawn nothing reports again, and every later confirm
  // waits behind it until the host unmounts.
  it('frees the queue when a stale press reports after the request was withdrawn', async () => {
    const view = await mountHost();
    const fiber = Effect.runFork(confirmSettingChange(FIRST));

    await waitFor(() => textNodes(view.renderer, FIRST).length === 1);

    // The person presses Cancel: the dialog starts the dismissal with the
    // pre-withdrawal cancel answer held over for the sheet's report.
    act(() => {
      const onPress = pressableWith(view.renderer, 'border-border').props.onPress as
        | (() => void)
        | undefined;
      onPress?.();
    });

    // The tool call is interrupted before the sheet can report.
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(getSettingsConfirmRequest()).toMatchObject({ withdrawn: true });

    // The sheet's dismissal finishes and reports now — through the dialog's
    // stale, pre-withdrawal answer.
    act(() => {
      const report = bottomSheet(view.renderer).props.onDismiss as (() => void) | undefined;
      report?.();
    });

    // The stale report must not pin the queue: the withdrawn request, which no
    // sheet is left to report again, is gone.
    expect(getSettingsConfirmRequest()).toBeUndefined();
    expect(view.renderer.toJSON()).toBeNull();

    // A later confirm draws its own dialog and resolves through it.
    const later = Effect.runPromise(confirmSettingChange(SECOND));
    await waitFor(() => textNodes(view.renderer, SECOND).length === 1);
    expect(getSettingsConfirmRequest()).toMatchObject({ summary: SECOND, withdrawn: false });

    act(() => {
      const onPress = pressableWith(view.renderer, 'bg-destructive').props.onPress as
        | (() => void)
        | undefined;
      onPress?.();
    });
    act(() => {
      const report = bottomSheet(view.renderer).props.onDismiss as (() => void) | undefined;
      report?.();
    });

    await expect(later).resolves.toBe(true);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });
});
