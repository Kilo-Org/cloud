import { Effect, Fiber } from 'effect';
import { createElement, Fragment, type ReactNode } from 'react';
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

import { PortalHost } from '@rn-primitives/portal';
import { SettingsConfirmHost } from './settings-confirm-host';

// `@rn-primitives/portal@1.5.3` ships untranspiled JSX (`dist/index.mjs`), which
// no Node-side test transformer parses — the same limit `vitest.setup.ts`
// records for `@rn-primitives/dialog`. This stand-in keeps the module's
// contract instead of passing children straight through: `Portal` renders
// nothing and hands its children to the host from an effect, and `PortalHost`
// renders what that store holds. A pass-through would put the dialog back in
// its caller's subtree and hide the placement this suite pins.
vi.mock('@rn-primitives/portal', async () => {
  const React = await import('react');

  const entries = new Map<string, ReactNode>();
  const listeners = new Set<() => void>();
  let snapshot: ReactNode[] = [];

  function emit(): void {
    snapshot = [...entries.values()];
    for (const listener of listeners) {
      listener();
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): ReactNode[] {
    return snapshot;
  }

  function Portal({ name = 'default', children }: { name?: string; children?: ReactNode }) {
    React.useEffect(() => {
      entries.set(name, children);
      emit();
    }, [name, children]);
    React.useEffect(
      () => () => {
        entries.delete(name);
        emit();
      },
      [name]
    );
    return null;
  }

  function Host() {
    const children = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return children.length === 0 ? null : React.createElement(React.Fragment, null, ...children);
  }

  return { Portal, PortalHost: Host };
});

vi.mock('react-native', () => ({
  // Sheet registers the app-level Android Back listener while it is visible.
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StatusBar: { currentHeight: 0 },
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
const SECOND = 'Change "theme" to "dark"';

let mounted: RenderWithProvidersResult | undefined = undefined;

/**
 * The app root's shape around this host: the host itself, and the `PortalHost`
 * it draws into. The root keeps that host outside the veil it applies to the
 * app tree while an in-tree modal surface is open.
 */
function SettingsConfirmHarness() {
  return createElement(
    Fragment,
    null,
    createElement(SettingsConfirmHost, null),
    createElement(PortalHost, null)
  );
}

async function mountHost(): Promise<RenderWithProvidersResult> {
  mounted = await renderWithProviders(createElement(SettingsConfirmHarness, null));
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

    act(() => {
      const onPress = pressableWith(view.renderer, 'bg-destructive').props.onPress as
        | (() => void)
        | undefined;
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

  // The dishonored press: the person cancels, the sheet hands its stay-over
  // report to the cancel answer captured before the tool call was interrupted,
  // and the withdrawal lands between the two. The report then runs the stale
  // closure, whose delivered answer must still free the queue entry — or the
  // withdrawn head stays drawn nothing reports again, and every later confirm
  // waits behind it until the host unmounts.
  it('frees the queue when a stale press reports after the request was withdrawn', async () => {
    const view = await mountHost();
    const fiber = Effect.runFork(confirmSettingChange(SUMMARY));

    await waitFor(() => textNodes(view.renderer, SUMMARY).length === 1);

    // The person presses Cancel: the dialog starts the dismissal with the
    // pre-withdrawal cancel answer held over for the sheet's report.
    act(() => {
      const onPress = pressableWith(view.renderer, 'border-input').props.onPress as
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

  // The root hides everything in the app tree — `pointerEvents="none"`,
  // `accessibilityElementsHidden`, `no-hide-descendants` — while an in-tree
  // modal surface (a `DialogCard`, the session preview overlay) is open, and
  // keeps only the app-root `PortalHost` outside that veil. The confirm must
  // therefore be drawn through the portal: drawn inline, the sheet that is the
  // dialog would sit inside the veiled tree, untappable and unannounced, which
  // is the state this case rejects.
  it('draws the dialog through the portal, beside the host and not under it', async () => {
    const view = await mountHost();

    act(() => {
      requestSettingsConfirmChange(SUMMARY, () => undefined);
    });

    await waitFor(
      () => view.renderer.root.findAll(node => isType(node, 'BottomSheet')).length === 1
    );

    const [host] = view.renderer.root.findAllByType(SettingsConfirmHost);
    if (host === undefined) {
      throw new Error('SettingsConfirmHost did not mount');
    }

    expect(host.findAllByType('BottomSheet' as never)).toHaveLength(0);
    expect(host.findAll(node => isType(node, 'BottomSheet'))).toHaveLength(0);
    expect(view.renderer.root.findAll(node => isType(node, 'BottomSheet'))).toHaveLength(1);
  });
});
