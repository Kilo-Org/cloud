/* eslint-disable typescript-eslint/no-deprecated, max-lines -- react-test-renderer mounts native presentation with mocked bridges. */
import { createElement, type ElementType } from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ContextControl, type ContextDisplayScope } from '@/components/context-control';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const list = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
const showPicker = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ token: 'token' as string | undefined }));
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
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 18 }) }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888' }),
}));

const Text = 'Text' as ElementType;
const Skeleton = 'Skeleton' as ElementType;
const Pressable = 'Pressable' as ElementType;
const name = 'An organization with a long name that must remain fully accessible';
const orgs = [{ organizationId: 'org-a', organizationName: name, role: 'owner' }];
type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;
const mounted: Mounted[] = [];
let persisted: string | null = null;

function Surface({ scope }: { scope?: ContextDisplayScope }) {
  const { organizationId: id } = useOrganization();
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
        { options: string[]; cancelButtonIndex: number; containerStyle: { paddingBottom: number } },
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
