/* eslint-disable max-lines -- test-renderer mounts native presentation with mocked bridges. */
import { createElement, type ElementType } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ContextControl, type ContextDisplayScope } from '@/components/context-control';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { accountPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const list = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
const auth = vi.hoisted(() => ({ token: 'token' as string | undefined }));
const platform = vi.hoisted(() => ({ OS: 'android' }));
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
// Mutable so the theme test can prove the picker re-reads the active palette,
// not just that one set of values is passed through. The initial values mirror
// the real dark tokens in theme-colors.generated.ts.
const appearance = vi.hoisted((): { colors: Record<string, string>; bottom: number } => ({
  colors: {
    card: '#17171A',
    foreground: '#F2F0EB',
    mutedForeground: '#8A8680',
    border: 'rgba(255, 255, 255, 0.07)',
    primary: '#FFDD00',
  },
  bottom: 18,
}));

// The palette the hook returns unless a test overrides it. The theme test
// reassigns `appearance.colors`, so the per-platform hook restores this default
// instead of leaking a test's palette into the tests that run after it.
const DEFAULT_COLORS = appearance.colors;
const DARK_COLORS = { ...appearance.colors };
const LIGHT_COLORS = {
  card: '#FFFFFF',
  foreground: '#14130F',
  mutedForeground: '#6F6A61',
  border: 'rgba(20, 15, 10, 0.09)',
  primary: '#4F5A10',
};
// The provider now announces the lost-membership recovery through the
// toast adapter, whose module graph reaches react-native's Flow source
// the mounted transform cannot parse. Suites mock the adapter (not the
// sonner package) so the mock sits at the edge that imports it.
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => auth }));
// The control presents the picker as a formSheet route, so the suite records
// the push and drives the bridge it seeded, the way the route reads it.
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@/lib/auth/logout-cleanup', () => ({ unregisterActivityTokensAndTombstone: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: storage.read,
  setItemAsync: storage.write,
  deleteItemAsync: storage.remove,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations-list'], queryFn: list }) },
    },
  }),
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: platform,
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: appearance.bottom }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => appearance.colors,
}));

const Text = 'Text' as ElementType;
const Skeleton = 'Skeleton' as ElementType;
const Pressable = 'Pressable' as ElementType;
const Check = 'Check' as ElementType;
const name = 'An organization with a long name that must remain fully accessible';
const orgs = [{ organizationId: 'org-a', organizationName: name, role: 'owner' }];
type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;
const mounted: Mounted[] = [];
let persisted: string | null = null;

function Surface({
  scope,
  value,
  onSelectionChange,
  variant,
  failurePlacement,
}: {
  scope?: ContextDisplayScope;
  value?: string | null;
  onSelectionChange?: (organizationId: string | null) => void;
  variant?: 'inline' | 'field';
  failurePlacement?: 'rows' | 'row' | 'none';
}) {
  const { organizationId: id } = useOrganization();
  return createElement(
    'GlobalScope',
    { id },
    createElement(ContextControl, { scope, value, onSelectionChange, variant, failurePlacement })
  );
}

async function mount(
  props: {
    scope?: ContextDisplayScope;
    value?: string | null;
    onSelectionChange?: (organizationId: string | null) => void;
    variant?: 'inline' | 'field';
    failurePlacement?: 'rows' | 'row' | 'none';
  } = {}
) {
  const result = await renderWithProviders(createElement(Surface, props), {
    wrapper: OrganizationProvider,
  });
  mounted.push(result);
  return result;
}

function texts(ui: Mounted) {
  return ui.renderer.root.findAll(node => node.type === Text).flatMap(node => node.children);
}

function picker(ui: Mounted) {
  return ui.renderer.root.findByProps({ accessibilityHint: 'Select account' });
}

function retry(ui: Mounted) {
  return ui.renderer.root.findByProps({ accessibilityLabel: 'Retry' });
}

async function press(node: ReactTestInstance) {
  const onPress = node.props.onPress as () => void;
  await act(() => {
    onPress();
  });
}

/** The bridge the opener seeds; the account-picker route reads this slot. */
function seededBridge() {
  const bridge = accountPickerSlot.get(UNFENCED_ROUTE_KEY);
  if (!bridge) {
    throw new Error('the opener seeded no account bridge');
  }
  return bridge;
}

async function openPicker(ui: Mounted) {
  await press(picker(ui));
}

async function pickAccount(accountId: string | null) {
  await act(() => {
    seededBridge().onSelect(accountId);
  });
}

beforeEach(() => {
  auth.token = 'token';
  persisted = null;
  accountPickerSlot.clearAll();
  router.push.mockClear();
  platform.OS = 'android';
  appearance.colors = { ...DARK_COLORS };
  list.mockReset().mockResolvedValue(orgs);
  storage.read.mockReset().mockResolvedValue(null);
  storage.write.mockReset().mockImplementation(async (key: string, value: string) => {
    // Only the organization key is the selection under test here: an explicit
    // Personal choice also writes the marker key beside it.
    if (key === ORGANIZATION_STORAGE_KEY) {
      persisted = value;
    }
    await Promise.resolve();
  });
  storage.remove.mockReset().mockImplementation(async (key: string) => {
    if (key === ORGANIZATION_STORAGE_KEY) {
      persisted = null;
    }
    await Promise.resolve();
  });
});
afterEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe.each(['ios', 'android'])('ContextControl on %s', os => {
  beforeEach(() => {
    platform.OS = os;
    appearance.colors = DEFAULT_COLORS;
    appearance.bottom = 18;
  });

  it.each([
    { id: null, label: 'Personal', result: [] },
    { id: 'org-a', label: name, result: orgs },
  ])('shows progress for $id membership lookup', async ({ id, label, result }) => {
    storage.read.mockResolvedValue(id);
    const names = Promise.withResolvers<typeof orgs>();
    list.mockReturnValue(names.promise);
    const ui = await mount();
    // An absent stored choice now waits for the organization list to settle
    // before it publishes Personal, so the label is still resolving here.
    expect(texts(ui)).not.toContain(label);
    expect(ui.renderer.root.findAllByType(Skeleton)).toHaveLength(1);
    expect(picker(ui).props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(picker(ui).findAllByType('ActivityIndicator' as ElementType)).toHaveLength(1);
    await act(() => {
      names.resolve(result);
    });
    await waitFor(() => !picker(ui).props.disabled);
    expect(texts(ui)).toContain(label);
    expect(picker(ui).props.accessibilityLabel).toBe(label);
    expect(picker(ui).findByType(Text).props.numberOfLines).toBe(1);
    // Memberships of one workspace share their leading words; the label keeps
    // its tail, which is the part that names the account.
    expect(picker(ui).findByType(Text).props.ellipsizeMode).toBe('middle');
    expect(picker(ui).props.accessibilityRole).toBe('button');
    expect(picker(ui).props.accessibilityState).toEqual({ busy: false, disabled: false });
    expect(picker(ui).findAllByType('ActivityIndicator' as ElementType)).toHaveLength(0);
  });

  it.each([
    { choice: 'Personal', accountId: null, expected: null },
    { choice: name, accountId: 'org-a', expected: 'org-a' },
    // The stored organization is missing from the list, so the provider
    // recovers to the first listed membership; the pick still applies.
  ])(
    'applies the picked account $choice without an implicit reset',
    async ({ accountId, expected }) => {
      storage.read.mockResolvedValue('org-missing');
      const ui = await mount();
      await waitFor(() => !picker(ui).props.disabled);
      await openPicker(ui);
      expect(seededBridge().rows.map(row => row.label)).toEqual(['Personal', name]);
      await pickAccount(accountId);
      expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe(expected);
    }
  );

  it('presents the account picker route with the memberships the caller holds', async () => {
    storage.read.mockResolvedValue('org-a');
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await openPicker(ui);
    expect(router.push).toHaveBeenCalledWith('/(app)/account-picker');
    expect(seededBridge()).toMatchObject({
      shownOrganizationId: 'org-a',
      rows: [
        { organizationId: null, label: 'Personal' },
        { organizationId: 'org-a', label: name },
      ],
    });
    expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe('org-a');
  });

  it("names the caller's account while the active one differs, and a pick still switches the active one", async () => {
    storage.read.mockResolvedValue('org-a');
    const onSelectionChange = vi.fn<(organizationId: string | null) => void>();
    const ui = await mount({ value: null, onSelectionChange });
    await waitFor(() => !picker(ui).props.disabled);
    // The screen is personal-scoped even though the active account is org-a,
    // so the control must not name org-a.
    expect(picker(ui).props.accessibilityLabel).toBe('Personal');
    await openPicker(ui);
    // The bridge carries the screen's own account, so the route marks Personal
    // even though the active account is org-a.
    expect(seededBridge().shownOrganizationId).toBe(null);
    await pickAccount('org-a');
    expect(onSelectionChange).toHaveBeenCalledWith('org-a');
  });

  it('reports no change when the pick matches the account the caller shows', async () => {
    storage.read.mockResolvedValue('org-a');
    const onSelectionChange = vi.fn<(organizationId: string | null) => void>();
    const ui = await mount({ value: null, onSelectionChange });
    await waitFor(() => !picker(ui).props.disabled);
    await openPicker(ui);
    await pickAccount(null);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it.each([
    // An absent stored choice is 'not chosen yet': the provider's login default
    // resolves to the first organization, so the picker must mark that row. A
    // stored organization missing from the list recovers to that first
    // membership before the sheet opens, so its row is marked too.
    { stored: null, selected: 'org-a' },
    { stored: 'org-missing', selected: 'org-a' },
  ])(
    'marks the account the user is actually on when the stored one is missing (stored=$stored)',
    async ({ stored, selected }) => {
      storage.read.mockResolvedValue(stored);
      const ui = await mount();
      await waitFor(() => !picker(ui).props.disabled);
      await openPicker(ui);
      expect(seededBridge().rows.map(row => row.label)).toEqual(['Personal', name]);
      expect(seededBridge().shownOrganizationId).toBe(selected);
    }
  );

  it('checks Personal when the membership list is empty', async () => {
    list.mockResolvedValue([]);
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await openPicker(ui);
    expect(seededBridge().rows).toEqual([{ organizationId: null, label: 'Personal' }]);
    expect(seededBridge().shownOrganizationId).toBe(null);
  });

  it('keeps the mocked palettes mirroring the generated theme tokens', () => {
    expect(DARK_COLORS).toEqual({
      card: darkColors.card,
      foreground: darkColors.foreground,
      mutedForeground: darkColors.mutedForeground,
      border: darkColors.border,
      primary: darkColors.primary,
    });
    expect(LIGHT_COLORS).toEqual({
      card: lightColors.card,
      foreground: lightColors.foreground,
      mutedForeground: lightColors.mutedForeground,
      border: lightColors.border,
      primary: lightColors.primary,
    });
  });

  it('recovers a stored organization missing from an empty membership list to Personal', async () => {
    storage.read.mockResolvedValue('org-missing');
    list.mockResolvedValue([]);
    const ui = await mount();
    // The stored organization is missing from the fetched list, so the
    // provider switches to Personal (no membership remains) on the first
    // snapshot instead of rendering the dead selection's error surface.
    await waitFor(
      () => ui.renderer.root.findByType('GlobalScope' as ElementType).props.id === null
    );
    expect(texts(ui)).not.toContain('Organization unavailable');
    await openPicker(ui);
    expect(seededBridge().rows.map(row => row.label)).toEqual(['Personal']);
  });

  it.each([false, true])('retries only the failed name query, read-only=%s', async readOnly => {
    storage.read.mockResolvedValue('org-a');
    list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(orgs);
    const ui = await mount(
      readOnly ? { scope: { organizationId: 'org-a', isResolved: true } } : undefined
    );
    await waitFor(() => texts(ui).includes("Couldn't load your organizations"));
    expect(retry(ui).props.accessibilityHint).toBe("Couldn't load your organizations");
    const status = ui.renderer.root.find(
      node => node.type === Text && node.props.children === "Couldn't load your organizations"
    );
    expect(status.children).toContain("Couldn't load your organizations");
    expect(status.props.accessibilityLiveRegion).toBe(os === 'android' ? 'polite' : undefined);
    await press(retry(ui));
    await waitFor(() => texts(ui).includes(name));
    expect(texts(ui)).not.toContain('Retry');
    expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe('org-a');
  });

  it('keeps a cached name visible through refetch failure and a busy explicit Retry', async () => {
    storage.read.mockResolvedValue('org-a');
    const ui = await mount();
    await waitFor(() => texts(ui).includes(name));
    const refresh = Promise.withResolvers<typeof orgs>();
    list.mockReturnValue(refresh.promise);
    await act(async () => {
      void ui.queryClient.invalidateQueries();
      // Flush the scheduled query notification before checking the pending frame.
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    expect(texts(ui)).toContain(name);
    expect(picker(ui).props.accessibilityState).toMatchObject({ busy: false });
    await act(() => {
      refresh.reject(new Error('offline'));
    });
    await waitFor(() => texts(ui).includes('Retry'));
    const names = Promise.withResolvers<typeof orgs>();
    list.mockReturnValue(names.promise);
    await press(retry(ui));
    await waitFor(() => retry(ui).props.disabled === true);
    expect(texts(ui)).toContain(name);
    expect(retry(ui).props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(retry(ui).findAllByType('ActivityIndicator' as ElementType)).toHaveLength(1);
    await act(() => {
      names.resolve(orgs);
    });
    await waitFor(() => !texts(ui).includes('Retry'));
    expect(texts(ui)).toContain(name);
  });

  it('leaves the account-list failure to the surface that draws it, never adding a row', async () => {
    storage.read.mockResolvedValue('org-a');
    list.mockRejectedValue(new Error('offline'));
    const ui = await mount({ failurePlacement: 'none' });
    // Home draws this failure and its Retry in its live-session card, and both
    // Retry actions would refetch the same query. Two rows stacked under a
    // fixed header's single row made that header taller by exactly their height,
    // so the body moved down while the list failed and back up on recovery.
    await waitFor(() => ui.renderer.root.findAll(node => node.type === Text).length === 1);
    expect(texts(ui)).not.toContain("Couldn't load your organizations");
    expect(texts(ui)).not.toContain('Retry');
    // The control gives up the failure block only: it still names an account and
    // stays the same single-row button.
    expect(picker(ui).props.accessibilityRole).toBe('button');
    expect(picker(ui).props.accessibilityLabel).toEqual(expect.any(String));
  });

  it('keeps the account-list failure inside its one row, and a press retries', async () => {
    storage.read.mockResolvedValue('org-a');
    list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(orgs);
    const ui = await mount({ failurePlacement: 'row' });
    // The personal scope has no other recovery for this query, so the row itself
    // becomes it: the label is the message and the press refetches the list.
    await waitFor(
      () =>
        ui.renderer.root.findAll(
          node =>
            node.type === Pressable &&
            node.props.accessibilityLabel === "Couldn't load your organizations"
        ).length === 1
    );
    const failureRow = ui.renderer.root.findAll(
      node =>
        node.type === Pressable &&
        node.props.accessibilityLabel === "Couldn't load your organizations"
    );
    // Still one row: the message is the label, and there is no message line, no
    // second Retry row, and no account picker chevron beside it.
    expect(texts(ui)).toEqual(["Couldn't load your organizations"]);
    expect(ui.renderer.root.findAll(node => node.type === Check)).toHaveLength(0);
    expect(failureRow[0]?.props.accessibilityRole).toBe('button');
    await press(failureRow[0] as ReactTestInstance);
    // The retry reaches the list, and the control returns to naming the account
    // with the picker it has on every healthy frame.
    await waitFor(() => texts(ui).includes(name));
    expect(texts(ui)).not.toContain("Couldn't load your organizations");
    expect(picker(ui).props.accessibilityHint).toBe('Select account');
  });

  it('keeps the picker on a failed refetch that still has cached memberships', async () => {
    storage.read.mockResolvedValue('org-a');
    const ui = await mount({ failurePlacement: 'row' });
    await waitFor(() => texts(ui).includes(name));
    // A background refetch fails while the memberships the picker needs are
    // still cached: the list is usable, so the row stays the picker and opens
    // the sheet, and the one-row placement only stops adding failure rows below.
    list.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await ui.queryClient.invalidateQueries();
    });
    await waitFor(() => texts(ui).includes(name));
    expect(texts(ui)).not.toContain('Retry');
    expect(picker(ui).props.accessibilityHint).toBe('Select account');
    await openPicker(ui);
    expect(seededBridge().rows.map(row => row.label)).toEqual(['Personal', name]);
  });

  it('keeps the stored choice failure in the control even when the list failure moves out', async () => {
    // Nothing else on the screen reaches the provider's own read/write failure,
    // so that message and its Retry stay wherever the control is mounted.
    storage.read.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue('org-a');
    const ui = await mount({ failurePlacement: 'none' });
    expect(texts(ui)).toContain('Something went wrong');
    await press(retry(ui));
    await waitFor(() => texts(ui).includes(name));
    expect(texts(ui)).not.toContain('Something went wrong');
    expect(texts(ui)).not.toContain('Retry');
  });

  it('offers restoration Retry without publishing Personal', async () => {
    storage.read.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue('org-a');
    const ui = await mount();
    expect(texts(ui)).toContain('Something went wrong');
    expect(texts(ui)).not.toContain('Personal');
    expect(picker(ui).props.disabled).toBe(true);
    await press(retry(ui));
    await waitFor(() => texts(ui).includes(name));
    expect(texts(ui)).not.toContain('Something went wrong');
  });

  it('announces a save failure, keeps the selection, and retries persistence', async () => {
    // A stored organization keeps the default from preselecting the first org,
    // so the picker choice below is a real change that exercises the save path.
    storage.read.mockResolvedValue('org-b');
    storage.write.mockRejectedValueOnce(new Error('write failed'));
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await openPicker(ui);
    await pickAccount('org-a');
    await waitFor(() => texts(ui).includes('Could not save setting'));
    expect(texts(ui)).toContain(name);
    expect(persisted).toBeNull();
    const save = Promise.withResolvers<undefined>();
    storage.write.mockImplementationOnce(async (_key: string, value: string) => {
      await save.promise;
      persisted = value;
    });
    await press(retry(ui));
    expect(texts(ui)).toContain(name);
    expect(texts(ui)).toContain('Could not save setting');
    expect(retry(ui).props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(retry(ui).props.disabled).toBe(true);
    expect(retry(ui).findAllByType('ActivityIndicator' as ElementType)).toHaveLength(1);
    expect(persisted).toBeNull();
    await act(() => {
      save.resolve(undefined);
    });
    await waitFor(() => persisted === 'org-a');
    expect(texts(ui)).not.toContain('Could not save setting');
    expect(texts(ui)).not.toContain('Retry');
  });

  it.each([
    { organizationId: null, expected: 'Personal' },
    { organizationId: 'org-a', expected: name },
    // The stored global scope ('global-org') is missing from the fetched
    // list, so the provider recovers to the first listed membership; the
    // explicit per-session scope stays read-only and independent of that.
    { organizationId: 'org-missing', expected: 'Organization unavailable' },
  ])(
    'keeps the resolved session scope $organizationId read-only and independent',
    async ({ organizationId, expected }) => {
      storage.read.mockResolvedValue('global-org');
      const ui = await mount({ scope: { organizationId, isResolved: true } });
      await waitFor(() => texts(ui).includes(expected));
      expect(ui.renderer.root.findAll(node => node.type === Pressable)).toHaveLength(0);
      expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe('org-a');
    }
  );

  it('does not infer Personal or offer a picker for unresolved session scope', async () => {
    storage.read.mockResolvedValue('global-org');
    const ui = await mount({ scope: { organizationId: null, isResolved: false } });
    // The stored global scope is missing from the list, so the provider
    // recovers to the first listed membership; the unresolved session scope
    // still infers nothing and offers no picker.
    await waitFor(
      () => ui.renderer.root.findByType('GlobalScope' as ElementType).props.id === 'org-a'
    );
    expect(texts(ui)).not.toContain('Personal');
    expect(ui.renderer.root.findAll(node => node.type === Skeleton)).toHaveLength(1);
    expect(ui.renderer.root.findAll(node => node.type === Pressable)).toHaveLength(0);
  });

  it.each(['pending', 'failed'])(
    'shows resolved Personal while global restoration is %s',
    async state => {
      if (state === 'pending') {
        storage.read.mockReturnValue(new Promise(() => undefined));
      } else {
        storage.read.mockRejectedValue(new Error('read failed'));
      }
      list.mockReturnValue(new Promise(() => undefined));
      const ui = await mount({ scope: { organizationId: null, isResolved: true } });
      expect(texts(ui)).toContain('Personal');
      expect(texts(ui)).not.toContain('Something went wrong');
      expect(ui.renderer.root.findAll(node => node.type === Skeleton)).toHaveLength(0);
      expect(ui.renderer.root.findAll(node => node.type === Pressable)).toHaveLength(0);
    }
  );

  it('keeps the picker disabled without an authenticated membership query', async () => {
    auth.token = undefined;
    const ui = await mount();
    expect(texts(ui)).toContain('Personal');
    expect(picker(ui).props.disabled).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it('renders the field variant as the stacked form triggers do', async () => {
    storage.read.mockResolvedValue(null);
    const ui = await mount({ variant: 'field' });
    await waitFor(() => !picker(ui).props.disabled);
    const trigger = picker(ui).props.className as string;
    // The same bordered, full-width box `InstanceSelector` and `RepoSelector`
    // render, so one label-value row on the form keeps one shape. The inline
    // default is a bare row with no box.
    expect(trigger).toContain('border');
    expect(trigger).toContain('bg-secondary');
    expect(trigger).toContain('justify-between');
    const label = picker(ui).findByType(Text);
    expect(label.props.className).toContain('flex-1');
    expect(label.props.className).toContain('text-foreground');
    const inline = await mount();
    const inlineTrigger = picker(inline).props.className as string;
    expect(inlineTrigger).not.toContain('bg-secondary');
  });
});
