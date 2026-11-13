/* eslint-disable max-lines -- test-renderer mounts native presentation with mocked bridges. */
import { createElement, type ElementType, type ReactNode } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ContextControl, type ContextDisplayScope } from '@/components/context-control';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { contextPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const list = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
const auth = vi.hoisted(() => ({ token: 'token' as string | undefined }));
// Mutable so the per-platform suite hands each platform the one sheet the picker
// builds: the current-account mark rides the row's checked state, never a
// per-platform label branch.
const platform = vi.hoisted(() => ({ OS: 'android' }));
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
const pushMock = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock, back: vi.fn() }),
}));
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
  // Sheet registers the app-level Android Back listener while it is visible.
  BackHandler: { addEventListener: vi.fn(() => ({ remove: () => undefined })) },
  ActivityIndicator: 'ActivityIndicator',
  // The picker's sheet is a native modal; honored like the real one so the
  // closed sheet renders nothing.
  Modal: (props: { visible?: boolean; children?: ReactNode }) =>
    props.visible ? createElement('Modal', null, props.children) : null,
  Platform: platform,
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ width: 400, height: 800 }),
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

/** The bridge the press handed the picker route, once the route was pushed. */
function pickerBridge() {
  const bridge = contextPickerSlot.get(UNFENCED_ROUTE_KEY);
  if (bridge === undefined) {
    throw new Error('the account picker route was not handed a bridge');
  }
  return bridge;
}

/** The account rows the route would render, in option order. */
function rows() {
  const bridge = contextPickerSlot.get(UNFENCED_ROUTE_KEY);
  if (bridge === undefined) {
    return [];
  }
  return bridge.options.map((label, index) => ({ label, selected: bridge.currentIndex === index }));
}

function accountRow(label: string) {
  const index = pickerBridge().options.indexOf(label);
  if (index === -1) {
    throw new Error(`${label} is not one of the picker's rows`);
  }
  return index;
}

/** Pressing the control opens the shared picker route with these rows. */
async function openSheet(ui: Mounted) {
  await press(picker(ui));
}

async function chooseRow(_ui: Mounted, label: string) {
  const bridge = pickerBridge();
  await act(() => {
    bridge.onSelect(accountRow(label));
  });
}

beforeEach(() => {
  auth.token = 'token';
  persisted = null;
  platform.OS = 'android';
  appearance.colors = { ...DARK_COLORS };
  contextPickerSlot.clearAll();
  pushMock.mockReset();
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
    { choice: 'Personal', expected: null },
    { choice: name, expected: 'org-a' },
  ])(
    'applies the picked account $choice without an implicit reset',
    async ({ choice, expected }) => {
      storage.read.mockResolvedValue('org-missing');
      const ui = await mount();
      await waitFor(() => !picker(ui).props.disabled);
      await openSheet(ui);
      expect(pushMock).toHaveBeenCalledWith('/(app)/context-picker');
      expect(rows().map(row => row.label)).toEqual(['Personal', name]);
      await chooseRow(ui, choice);
      expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe(expected);
    }
  );

  it('leaves the account unchanged when the picker is dismissed without a pick', async () => {
    storage.read.mockResolvedValue('org-missing');
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    // The stored organization is missing from the list, so the provider has
    // already recovered to the first listed membership before the picker opens.
    await waitFor(
      () => ui.renderer.root.findByType('GlobalScope' as ElementType).props.id === 'org-a'
    );
    await openSheet(ui);
    // The route owns its own dismissal (Done, Android Back, the sheet gesture):
    // none of them reaches the caller, so nothing here changes the scope.
    expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe('org-a');
  });

  it('marks the current account in the rows the picker route receives', async () => {
    storage.read.mockResolvedValue('org-a');
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await openSheet(ui);
    const opened = rows();
    expect(opened.map(row => row.label)).toEqual(['Personal', name]);
    expect(opened.map(row => row.selected)).toEqual([false, true]);
  });

  it("names the caller's account while the active one differs, and a pick still switches the active one", async () => {
    storage.read.mockResolvedValue('org-a');
    const onSelectionChange = vi.fn<(organizationId: string | null) => void>();
    const ui = await mount({ value: null, onSelectionChange });
    await waitFor(() => !picker(ui).props.disabled);
    // The screen is personal-scoped even though the active account is org-a,
    // so the control must not name org-a.
    expect(picker(ui).props.accessibilityLabel).toBe('Personal');
    await openSheet(ui);
    expect(rows().map(row => row.selected)).toEqual([true, false]);
    await chooseRow(ui, name);
    expect(onSelectionChange).toHaveBeenCalledWith('org-a');
  });

  it('reports no change when the pick matches the account the caller shows', async () => {
    storage.read.mockResolvedValue('org-a');
    const onSelectionChange = vi.fn<(organizationId: string | null) => void>();
    const ui = await mount({ value: null, onSelectionChange });
    await waitFor(() => !picker(ui).props.disabled);
    await openSheet(ui);
    await chooseRow(ui, 'Personal');
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it.each([
    // An absent stored choice is 'not chosen yet': the provider's login default
    // resolves to the first organization, so the picker must mark that row. A
    // stored organization missing from the list recovers to that first
    // membership before the sheet opens, so its row is marked too.
    { stored: null, selected: name },
    { stored: 'org-missing', selected: name },
  ])(
    'marks the account the user is actually on when the stored one is missing (stored=$stored)',
    async ({ stored, selected }) => {
      storage.read.mockResolvedValue(stored);
      const ui = await mount();
      await waitFor(() => !picker(ui).props.disabled);
      await openSheet(ui);
      expect(rows().map(row => row.label)).toEqual(['Personal', name]);
      expect(
        rows()
          .filter(row => row.selected)
          .map(row => row.label)
      ).toEqual([selected]);
    }
  );

  it('checks Personal when the membership list is empty', async () => {
    list.mockResolvedValue([]);
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await openSheet(ui);
    expect(rows()).toEqual([{ label: 'Personal', selected: true }]);
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
    await openSheet(ui);
    expect(rows().map(row => row.label)).toEqual(['Personal']);
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
    await openSheet(ui);
    expect(rows().map(row => row.label)).toEqual(['Personal', name]);
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
    await openSheet(ui);
    await chooseRow(ui, name);
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
    // render, so one label-value column on the form keeps one shape. The frame
    // carries the chrome and the body inside it the 48 dp height, so a value,
    // a skeleton or a retry fills one box. The inline default is a bare row
    // with no box.
    expect(trigger).toContain('border');
    expect(trigger).toContain('bg-secondary');
    expect(trigger).not.toContain('min-h-');
    const body = picker(ui).find(
      node =>
        typeof node.props.className === 'string' && node.props.className.includes('min-h-[48px]')
    );
    expect(body.props.className).toContain('flex-1');
    const label = picker(ui).findByType(Text);
    expect(label.props.className).toContain('flex-1');
    expect(label.props.className).toContain('text-foreground');
    // The column's chevrons all end on the body's trailing edge — the
    // Repository and Branch triggers draw a bare 14 dp glyph — so this one must
    // not sit in a fixed `size-5` box (17.52 dp at this app's 14 pt rem), which
    // left the top chevron ~1.9 dp short of the ones below it.
    const glyphBox = picker(ui).findByType('ChevronDown' as never).parent?.props
      .className as string;
    expect(glyphBox).not.toContain('size-5');
    const inline = await mount();
    const inlineTrigger = picker(inline).props.className as string;
    expect(inlineTrigger).not.toContain('bg-secondary');
    // The inline row keeps its fixed glyph box, which holds the line height.
    const inlineGlyphBox = picker(inline).findByType('ChevronDown' as never).parent?.props
      .className as string;
    expect(inlineGlyphBox).toContain('size-5');
  });
});
