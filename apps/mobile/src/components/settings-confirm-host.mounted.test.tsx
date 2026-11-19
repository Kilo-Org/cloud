import { Effect } from 'effect';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type TestRenderer } from '@/test/renderer';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';
import {
  confirmSettingChange,
  getSettingsConfirmRequest,
  requestSettingsConfirmChange,
  setSettingsConfirmHostMounted,
  settleAllSettingsConfirms,
} from '@/lib/settings/confirm';

import { SettingsConfirmHost } from './settings-confirm-host';

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

  it('renders the dialog for a pending request', async () => {
    const view = await mountHost();

    act(() => {
      requestSettingsConfirmChange(SUMMARY);
    });

    await waitFor(() => textNodes(view.renderer, SUMMARY).length === 1);
    expect(textNodes(view.renderer, 'Confirm this change?')).toHaveLength(1);
    expect(textNodes(view.renderer, 'Save')).toHaveLength(1);
    expect(textNodes(view.renderer, 'Cancel')).toHaveLength(1);
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
});
