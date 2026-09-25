/* eslint-disable max-lines -- test-renderer mounts native presentation with mocked bridges. */
import { createElement, type ElementType, type ReactNode, useEffect, useState } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ContextControl, type ContextDisplayScope } from '@/components/context-control';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
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
    primary: '#E8F27A',
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
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => auth }));
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
let rerender: (() => void) | undefined = undefined;

function Surface({ scope }: { scope?: ContextDisplayScope }) {
  const { organizationId: id } = useOrganization();
  const [, setVersion] = useState(0);
  useEffect(() => {
    rerender = () => {
      setVersion(version => version + 1);
    };
  }, []);
  return createElement('GlobalScope', { id }, createElement(ContextControl, { scope }));
}

async function mount(scope?: ContextDisplayScope) {
  const result = await renderWithProviders(createElement(Surface, { scope }), {
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

/** The open sheet's account rows, in option order, with their a11y state. */
function rows(ui: Mounted) {
  return ui.renderer.root
    .findAll(node => node.type === Pressable && node.props.accessibilityRole === 'radio')
    .map(node => {
      const checks = node.findAll(child => child.type === Check);
      return {
        label: node.props.accessibilityLabel as string,
        role: node.props.accessibilityRole as string,
        checked: (node.props.accessibilityState as { checked: boolean }).checked,
        divider:
          typeof node.props.className === 'string' &&
          node.props.className.includes('border-hair-soft'),
        check: checks.length > 0,
        checkColor: checks[0]?.props.color as string | undefined,
      };
    });
}

function radioRow(ui: Mounted, label: string) {
  return ui.renderer.root.findByProps({ accessibilityLabel: label, accessibilityRole: 'radio' });
}

/** The outer backdrop pressable of the open sheet. */
function backdrop(ui: Mounted) {
  return ui.renderer.root.find(
    node =>
      node.type === Pressable &&
      node.props.accessible === false &&
      String(node.props.className).includes('justify-end')
  );
}

/** The Cancel row of the open sheet: a plain button with no radio state. */
function cancelRow(ui: Mounted) {
  return ui.renderer.root.find(
    node =>
      node.type === Pressable &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Cancel' &&
      node.props.accessibilityHint === undefined
  );
}

async function openSheet(ui: Mounted) {
  await press(picker(ui));
}

async function chooseRow(ui: Mounted, label: string) {
  await press(radioRow(ui, label));
}

beforeEach(() => {
  auth.token = 'token';
  persisted = null;
  rerender = undefined;
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
    expect(picker(ui).props.accessibilityRole).toBe('button');
    expect(picker(ui).props.accessibilityState).toEqual({ busy: false, disabled: false });
    expect(picker(ui).findAllByType('ActivityIndicator' as ElementType)).toHaveLength(0);
  });

  it.each([
    { choice: 'Personal', expected: null },
    { choice: name, expected: 'org-a' },
    { choice: 'Cancel', expected: 'org-missing' },
  ])(
    'applies the picked account $choice without an implicit reset',
    async ({ choice, expected }) => {
      storage.read.mockResolvedValue('org-missing');
      const ui = await mount();
      await waitFor(() => !picker(ui).props.disabled);
      await openSheet(ui);
      expect(rows(ui).map(row => row.label)).toEqual(['Personal', name]);
      expect(texts(ui)).toContain('Cancel');
      await press(choice === 'Cancel' ? cancelRow(ui) : radioRow(ui, choice));
      expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe(expected);
    }
  );

  it('dismisses the sheet without changing the scope', async () => {
    storage.read.mockResolvedValue('org-missing');
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await openSheet(ui);
    // The backdrop, not a row: the scope stays as it was.
    await press(backdrop(ui));
    expect(rows(ui)).toHaveLength(0);
    expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe('org-missing');
  });

  it('separates the rows and exposes the current account through the radio state', async () => {
    storage.read.mockResolvedValue('org-a');
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await openSheet(ui);
    const opened = rows(ui);
    expect(opened.map(row => row.label)).toEqual(['Personal', name]);
    // A screen reader hears the current account through `checked`, the app's
    // radio convention (`ui/radio-group.tsx`), not through icon colour alone.
    expect(opened.map(row => row.checked)).toEqual([false, true]);
    expect(opened.map(row => row.role)).toEqual(['radio', 'radio']);
    // Each account row draws the shared divider, and only the current row
    // carries the check; Cancel is a plain button with no radio state.
    expect(opened.map(row => row.divider)).toEqual([true, true]);
    expect(opened.map(row => row.check)).toEqual([false, true]);
    expect(cancelRow(ui).props.accessibilityState).toBeUndefined();
  });

  it.each([
    // An absent stored choice is 'not chosen yet': the provider's login default
    // resolves to the first organization, so the picker must mark that row. A
    // stored organization missing from the list marks no row at all.
    { stored: null, checked: name },
    { stored: 'org-missing', checked: undefined },
  ])(
    'marks the account the user is actually on when the stored one is missing (stored=$stored)',
    async ({ stored, checked }) => {
      storage.read.mockResolvedValue(stored);
      const ui = await mount();
      await waitFor(() => !picker(ui).props.disabled);
      await openSheet(ui);
      expect(rows(ui).map(row => row.label)).toEqual(['Personal', name]);
      expect(
        rows(ui)
          .filter(row => row.checked)
          .map(row => row.label)
      ).toEqual(checked === undefined ? [] : [checked]);
    }
  );

  it('checks Personal when the membership list is empty', async () => {
    list.mockResolvedValue([]);
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await openSheet(ui);
    expect(
      rows(ui).map(row => ({ label: row.label, checked: row.checked, check: row.check }))
    ).toEqual([{ label: 'Personal', checked: true, check: true }]);
    expect(texts(ui)).toContain('Cancel');
  });

  it('paints the current-account check with the active theme colors', async () => {
    storage.read.mockResolvedValue('org-a');
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await openSheet(ui);
    expect(rows(ui)[1]?.checkColor).toBe(DARK_COLORS.primary);

    // Switching the active palette and re-rendering must change what the sheet
    // paints; the picker cannot be hardcoding the dark tokens.
    appearance.colors = { ...LIGHT_COLORS };
    await act(() => {
      rerender?.();
    });
    expect(rows(ui)[1]?.checkColor).toBe(LIGHT_COLORS.primary);
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

  it('recovers an unavailable organization through Personal after an empty membership result', async () => {
    storage.read.mockResolvedValue('org-missing');
    list.mockResolvedValue([]);
    const ui = await mount();
    await waitFor(() => texts(ui).includes('Organization unavailable'));
    expect(texts(ui)).not.toContain('Retry');
    expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe('org-missing');
    await openSheet(ui);
    expect(rows(ui).map(row => row.label)).toEqual(['Personal']);
    await chooseRow(ui, 'Personal');
    expect(texts(ui)).toContain('Personal');
    expect(texts(ui)).not.toContain('Organization unavailable');
  });

  it.each([false, true])('retries only the failed name query, read-only=%s', async readOnly => {
    storage.read.mockResolvedValue('org-a');
    list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(orgs);
    const ui = await mount(readOnly ? { organizationId: 'org-a', isResolved: true } : undefined);
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
    { organizationId: 'org-missing', expected: 'Organization unavailable' },
  ])(
    'keeps the resolved session scope $organizationId read-only and independent',
    async ({ organizationId, expected }) => {
      storage.read.mockResolvedValue('global-org');
      const ui = await mount({ organizationId, isResolved: true });
      await waitFor(() => texts(ui).includes(expected));
      expect(ui.renderer.root.findAll(node => node.type === Pressable)).toHaveLength(0);
      expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe('global-org');
    }
  );

  it('does not infer Personal or offer a picker for unresolved session scope', async () => {
    storage.read.mockResolvedValue('global-org');
    const ui = await mount({ organizationId: null, isResolved: false });
    expect(texts(ui)).not.toContain('Personal');
    expect(ui.renderer.root.findAll(node => node.type === Skeleton)).toHaveLength(1);
    expect(ui.renderer.root.findAll(node => node.type === Pressable)).toHaveLength(0);
    expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe('global-org');
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
      const ui = await mount({ organizationId: null, isResolved: true });
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
});
