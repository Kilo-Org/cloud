/* eslint-disable max-lines -- test-renderer mounts native presentation with mocked bridges. */
import { createElement, type ElementType, useEffect, useState } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ContextControl, type ContextDisplayScope } from '@/components/context-control';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const list = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
const showPicker = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ token: 'token' as string | undefined }));
// Mutable so the theme test can prove the picker re-reads the active palette,
// not just that the dark values are passed through. Values mirror the real
// light/dark tokens in theme-colors.generated.ts.
const theme = vi.hoisted(() => ({
  colors: {
    card: '#17171A',
    foreground: '#F2F0EB',
    mutedForeground: '#8A8680',
    border: 'rgba(255, 255, 255, 0.07)',
  },
}));
const DARK_COLORS = { ...theme.colors };
const LIGHT_COLORS = {
  card: '#FFFFFF',
  foreground: '#14130F',
  mutedForeground: '#6F6A61',
  border: 'rgba(20, 15, 10, 0.09)',
};
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => auth }));
vi.mock('@/lib/auth/logout-cleanup', () => ({ unregisterActivityTokensAndTombstone: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: storage.read,
  setItemAsync: storage.write,
  deleteItemAsync: storage.remove,
}));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: showPicker }),
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
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 18 }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => theme.colors,
}));

const Text = 'Text' as ElementType;
const Skeleton = 'Skeleton' as ElementType;
const Pressable = 'Pressable' as ElementType;
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

function nativePicker() {
  const call = showPicker.mock.lastCall as
    | [
        {
          options: string[];
          cancelButtonIndex: number;
          title: string;
          showSeparators: boolean;
          icons: ReactTestInstance[];
          separatorStyle: { backgroundColor: string };
          containerStyle: { paddingTop: number; paddingBottom: number; backgroundColor: string };
          textStyle: { color: string };
          titleTextStyle: { color: string };
        },
        (index?: number) => void,
      ]
    | undefined;
  if (!call) {
    throw new Error('native picker did not open');
  }
  return { options: call[0], choose: call[1] };
}

beforeEach(() => {
  auth.token = 'token';
  persisted = null;
  rerender = undefined;
  theme.colors = { ...DARK_COLORS };
  list.mockReset().mockResolvedValue(orgs);
  storage.read.mockReset().mockResolvedValue(null);
  storage.write.mockReset().mockImplementation(async (_key: string, value: string) => {
    persisted = value;
    await Promise.resolve();
  });
  storage.remove.mockReset().mockImplementation(async () => {
    persisted = null;
    await Promise.resolve();
  });
  showPicker.mockReset();
});
afterEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe('ContextControl', () => {
  it.each([
    { id: null, label: 'Personal', result: [] },
    { id: 'org-a', label: name, result: orgs },
  ])('shows progress for $id membership lookup', async ({ id, label, result }) => {
    storage.read.mockResolvedValue(id);
    const names = Promise.withResolvers<typeof orgs>();
    list.mockReturnValue(names.promise);
    const ui = await mount();
    expect(texts(ui).includes('Personal')).toBe(id === null);
    expect(ui.renderer.root.findAllByType(Skeleton)).toHaveLength(id === null ? 0 : 1);
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
    { index: 0, expected: null },
    { index: 1, expected: 'org-a' },
    { index: 2, expected: 'org-missing' },
    { index: undefined, expected: 'org-missing' },
  ])(
    'uses native choices and handles choice $index without an implicit reset',
    async ({ index, expected }) => {
      storage.read.mockResolvedValue('org-missing');
      const ui = await mount();
      await waitFor(() => !picker(ui).props.disabled);
      await press(picker(ui));
      const native = nativePicker();
      expect(native.options.options).toEqual(['Personal', name, 'Cancel']);
      expect(native.options.cancelButtonIndex).toBe(2);
      expect(native.options.containerStyle.paddingBottom).toBe(18);
      await act(() => {
        native.choose(index);
      });
      expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe(expected);
    }
  );

  it('themes the native picker with the active theme colors', async () => {
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await press(picker(ui));
    const dark = nativePicker();
    expect(dark.options.title).toBe('Select account');
    expect(dark.options.containerStyle).toEqual({
      paddingTop: 24,
      paddingBottom: 18,
      backgroundColor: DARK_COLORS.card,
    });
    expect(dark.options.textStyle).toEqual({ color: DARK_COLORS.foreground });
    expect(dark.options.titleTextStyle).toEqual({ color: DARK_COLORS.mutedForeground });

    // Switching the active palette and re-rendering must change what the sheet
    // receives; the picker cannot be hardcoding the dark tokens.
    theme.colors = { ...LIGHT_COLORS };
    await act(() => {
      rerender?.();
    });
    await press(picker(ui));
    const light = nativePicker();
    expect(light.options.containerStyle).toEqual({
      paddingTop: 24,
      paddingBottom: 18,
      backgroundColor: LIGHT_COLORS.card,
    });
    expect(light.options.textStyle).toEqual({ color: LIGHT_COLORS.foreground });
    expect(light.options.titleTextStyle).toEqual({ color: LIGHT_COLORS.mutedForeground });
  });

  // The explorer finding: the switcher was a bare list — no separators, and
  // nothing saying which account it was switching away from.
  it('separates the scope rows and marks the current scope', async () => {
    storage.read.mockResolvedValue('org-a');
    const ui = await mount();
    await waitFor(() => texts(ui).includes(name));
    await press(picker(ui));
    const sheet = nativePicker();

    expect(sheet.options.showSeparators).toBe(true);
    expect(sheet.options.separatorStyle).toEqual({ backgroundColor: DARK_COLORS.border });
    // The library draws `icons[i]` before row `i` of the one group it builds
    // from every option — the trailing Cancel included — so the slot count must
    // match the option count or the later rows lose their column. The org is
    // row 1 (Personal is row 0), and only it draws the check.
    expect(sheet.options.icons).toHaveLength(sheet.options.options.length);
    expect(sheet.options.icons.map(icon => icon.type)).toEqual(['View', 'Check', 'View']);
    expect(sheet.options.icons[0]?.props.className).toBe('h-[18px] w-[18px]');

    // Switching to Personal moves the check to its own row on the next open.
    await act(() => {
      sheet.choose(0);
    });
    await waitFor(() => texts(ui).includes('Personal'));
    await press(picker(ui));
    expect(nativePicker().options.icons.map(icon => icon.type)).toEqual(['Check', 'View', 'View']);
  });

  it('keeps the mocked palettes mirroring the generated theme tokens', () => {
    expect(DARK_COLORS).toEqual({
      card: darkColors.card,
      foreground: darkColors.foreground,
      mutedForeground: darkColors.mutedForeground,
      border: darkColors.border,
    });
    expect(LIGHT_COLORS).toEqual({
      card: lightColors.card,
      foreground: lightColors.foreground,
      mutedForeground: lightColors.mutedForeground,
      border: lightColors.border,
    });
  });

  it('recovers an unavailable organization through Personal after an empty membership result', async () => {
    storage.read.mockResolvedValue('org-missing');
    list.mockResolvedValue([]);
    const ui = await mount();
    await waitFor(() => texts(ui).includes('Organization unavailable'));
    expect(texts(ui)).not.toContain('Retry');
    expect(ui.renderer.root.findByType('GlobalScope' as ElementType).props.id).toBe('org-missing');
    await press(picker(ui));
    const native = nativePicker();
    expect(native.options.options).toEqual(['Personal', 'Cancel']);
    await act(() => {
      native.choose(0);
    });
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
      node => node.type === Text && node.props.accessibilityLiveRegion === 'polite'
    );
    expect(status.children).toContain("Couldn't load your organizations");
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
    storage.write.mockRejectedValueOnce(new Error('write failed'));
    const ui = await mount();
    await waitFor(() => !picker(ui).props.disabled);
    await press(picker(ui));
    await act(() => {
      nativePicker().choose(1);
    });
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
