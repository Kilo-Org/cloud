import { createElement, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModeForm } from '@/components/organization/mode-form';
import { type OrgMode } from '@/components/organization/org-mode-form-model';
import { FormField } from '@/components/ui/form-field';
import { i18n } from '@/i18n';
import { backAcceptedBy, noteAcceptedBack, resetLeaveSettle } from '@/lib/navigation/leave-settle';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  repeat: vi.fn(),
  /** The guard flag the replay saw, so a replay before the disarm is visible. */
  repeatSawEnabled: [] as boolean[],
  guard: {
    enabled: false as boolean,
    handler: undefined as
      | ((options: { data: { action: { type: string } }; repeat: () => void }) => void)
      | undefined,
  },
  mutations: {
    create: { isPending: false, mutate: vi.fn() },
    update: { isPending: false, mutate: vi.fn() },
    remove: { isPending: false, mutate: vi.fn() },
  },
}));

// The real Save control loads its spinner policy through the Expo runtime
// (battery level and reanimated), which this Node project cannot import.
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
// `vi.mock` factories are hoisted above this file's imports, so the scroll host
// comes in dynamically; the form's ref lands on it.
vi.mock('react-native', async () => {
  const { MockScrollView } = await import('@/test/scroll-view-mock');
  return {
    I18nManager: { isRTL: false },
    Platform: { OS: 'android' },
    Pressable: 'Pressable',
    ScrollView: MockScrollView,
    TextInput: 'TextInput',
    View: 'View',
    useColorScheme: () => 'light',
  };
});
// Hoisted as well: the tab-screen wrapper is where the form's scroll ref lands.
vi.mock('@/components/tab-screen', async () => {
  const { MockScrollView } = await import('@/test/scroll-view-mock');
  return { TabScreenScrollView: MockScrollView };
});
// The button's label reads this context, so the stub needs a real one.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});
// The guard itself is under test, so it is not mocked: only the navigator and
// the confirm host are stubbed, and `usePreventRemove` keeps the flag and the
// handler a real screen would hand the native stack.
vi.mock('expo-router', () => ({
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: { type: string } }; repeat: () => void }) => void
  ) => {
    h.guard.enabled = enabled;
    h.guard.handler = handler;
  },
  useRouter: () => ({ canGoBack: () => true, replace: h.replace }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/lib/hooks/use-org-modes-queries', () => ({
  useOrgModeMutations: () => h.mutations,
}));
// The real `usePopOnce` dismisses the route through the navigator, which
// dispatches a POP removal the guard sees: the stub does the same so a suite can
// tell a leave the guard replayed from one it dropped.
vi.mock('@/lib/navigation/pop-once', () => ({
  usePopOnce: () => () => {
    h.pop();
    h.guard.handler?.({
      data: { action: { type: 'POP' } },
      repeat: () => {
        h.repeat();
      },
    });
  },
}));
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: h.replace }),
}));
vi.mock('@/components/organization/mode-tools-fields', () => ({
  ModeToolsFields: 'ModeToolsFields',
}));

const PRESSABLE: unknown = 'Pressable';

const nameLabel = i18n.t('organization.modes.nameLabel');
const roleLabel = i18n.t('organization.modes.roleLabel');

function storedMode(id: string, name: string, slug: string): OrgMode {
  return {
    id,
    organization_id: 'org-1',
    name,
    slug,
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    config: {
      roleDefinition: `You are the ${name} mode.`,
      description: '',
      whenToUse: '',
      customInstructions: '',
      groups: ['read'],
    },
  };
}

const existingModes: readonly OrgMode[] = [storedMode('mode-1', 'Architect', 'architect')];

type WidgetProps = Record<string, unknown>;

function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = root
    .findAll(node => node.type === FormField)
    .find(node => (node.props as WidgetProps).label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

function changeField(root: ReactTestInstance, label: string, value: string): void {
  const onChangeText = (findField(root, label).props as WidgetProps).onChangeText;
  if (typeof onChangeText !== 'function') {
    throw new TypeError('expected a change handler');
  }
  act(() => {
    (onChangeText as (text: string) => void)(value);
  });
}

function pressSave(root: ReactTestInstance): void {
  const [button, ...extra] = root.findAll(
    node => node.type === PRESSABLE && (node.props as WidgetProps).role === 'button'
  );
  if (button === undefined || extra.length > 0) {
    throw new Error(`expected one action button, received ${extra.length + 1}`);
  }
  const onPress = (button.props as WidgetProps).onPress;
  if (typeof onPress !== 'function') {
    throw new TypeError('expected a press handler');
  }
  act(() => {
    (onPress as () => void)();
  });
}

/** Hand the guard the removal the navigator produces for a Back press. */
function pressBack(handler = h.guard.handler): void {
  if (!handler) {
    throw new Error('the metadata guard did not register a removal handler');
  }
  act(() => {
    handler({
      data: { action: { type: 'GO_BACK' } },
      repeat: () => {
        h.repeatSawEnabled.push(h.guard.enabled);
        h.repeat();
      },
    });
  });
}

/** Hand the guard a forward removal, which the navigator does not call a leave. */
function pressForward(): void {
  const handler = h.guard.handler;
  if (!handler) {
    throw new Error('the metadata guard did not register a removal handler');
  }
  act(() => {
    handler({
      data: { action: { type: 'NAVIGATE' } },
      repeat: () => {
        h.repeatSawEnabled.push(h.guard.enabled);
        h.repeat();
      },
    });
  });
}

/**
 * The mocked mutation hook reports its pending flag at render, so the harness
 * re-renders the same `ModeForm` instance when a test flips it — the way a
 * mutation that starts or settles re-renders the real form.
 */
type PendingBox = { setCreatePending: (pending: boolean) => void };

function PendingHarness({ box }: Readonly<{ box: PendingBox }>) {
  const [, setVersion] = useState(0);
  box.setCreatePending = (pending: boolean) => {
    h.mutations.create.isPending = pending;
    act(() => {
      setVersion(version => version + 1);
    });
  };
  return createElement(ModeForm, { organizationId: 'org-1', mode: undefined, existingModes });
}

async function mountGuardForm() {
  const box: PendingBox = { setCreatePending: () => undefined };
  const mounted = await renderWithProviders(createElement(PendingHarness, { box }));
  return { ...mounted, box };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLeaveSettle();
  h.mutations.create.isPending = false;
  h.mutations.update.isPending = false;
  h.mutations.remove.isPending = false;
  h.repeatSawEnabled = [];
  h.guard.enabled = false;
  h.guard.handler = undefined;
});

describe('ModeForm leave guard while a write is in flight', () => {
  it('asks before leaving a dirty form when no write is in flight', async () => {
    const { renderer, unmount } = await mountGuardForm();

    changeField(renderer.root, nameLabel, 'Security Reviewer');
    expect(h.guard.enabled).toBe(true);

    pressBack();

    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.repeat).not.toHaveBeenCalled();

    unmount();
  });

  // The in-flight write owns the route. This case fails on the code before the
  // fix: the pending create was invisible to the guard, so the Back press raised
  // the discard prompt and Discard popped a route whose write still landed.
  it('drops a Back press while the create it started is in flight', async () => {
    const { renderer, box, unmount } = await mountGuardForm();

    changeField(renderer.root, nameLabel, 'Security Reviewer');
    box.setCreatePending(true);
    expect(h.guard.enabled).toBe(true);

    pressBack();

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).not.toHaveBeenCalled();
    expect(h.guard.enabled).toBe(true);

    unmount();
  });

  // `usePopOnce` records the Back before it lets the press continue. A dropped
  // Back never leaves, so the guard must free that mark: the save's own pop is
  // spent on it otherwise and the form would stay on the saved record.
  it('frees the accepted Back it drops while the create is in flight', async () => {
    const { renderer, box, unmount } = await mountGuardForm();

    changeField(renderer.root, nameLabel, 'Security Reviewer');
    box.setCreatePending(true);
    noteAcceptedBack('probe-route');

    pressBack();

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).not.toHaveBeenCalled();
    expect(backAcceptedBy('probe-route')).toBe(false);

    unmount();
  });

  it('lets a forward removal through while the create is in flight', async () => {
    const { renderer, box, unmount } = await mountGuardForm();

    changeField(renderer.root, nameLabel, 'Security Reviewer');
    box.setCreatePending(true);

    pressForward();

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).toHaveBeenCalledOnce();
    expect(h.repeatSawEnabled).toEqual([false]);

    unmount();
  });

  it('asks again once the write settles and the form is still dirty', async () => {
    const { renderer, box, unmount } = await mountGuardForm();

    changeField(renderer.root, nameLabel, 'Security Reviewer');
    box.setCreatePending(true);
    pressBack();
    expect(h.confirm).not.toHaveBeenCalled();

    box.setCreatePending(false);
    pressBack();

    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.repeat).not.toHaveBeenCalled();

    unmount();
  });

  it('leaves without asking once the create succeeds', async () => {
    h.mutations.create.mutate.mockImplementation(
      (_variables: unknown, options: { onSuccess: (created: unknown) => void }) => {
        options.onSuccess({ result: { id: 'mode-9' } });
      }
    );
    const { renderer, unmount } = await mountGuardForm();

    changeField(renderer.root, nameLabel, 'Security Reviewer');
    changeField(renderer.root, roleLabel, 'Reviews every change.');
    pressSave(renderer.root);

    await waitFor(() => h.pop.mock.calls.length > 0);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.guard.enabled).toBe(false);

    unmount();
  });

  // The success path's own pop is not a Back press: it must land even while the
  // create still reports pending, or a successful save leaves the form open on
  // the record it just created.
  it('pops after a successful create that still reports pending', async () => {
    h.mutations.create.isPending = true;
    h.mutations.create.mutate.mockImplementation(
      (_variables: unknown, options: { onSuccess: (created: unknown) => void }) => {
        options.onSuccess({ result: { id: 'mode-9' } });
      }
    );
    const { renderer, box, unmount } = await mountGuardForm();

    changeField(renderer.root, nameLabel, 'Security Reviewer');
    changeField(renderer.root, roleLabel, 'Reviews every change.');
    pressSave(renderer.root);

    await waitFor(() => h.pop.mock.calls.length > 0);

    expect(h.pop).toHaveBeenCalledOnce();
    expect(h.confirm).not.toHaveBeenCalled();
    // The pop the success dispatched is a removal the armed guard saw: it has to
    // replay it, or the route stays on the record the form just created.
    await waitFor(() => h.repeat.mock.calls.length > 0);
    expect(h.repeat).toHaveBeenCalledOnce();

    // The success cleared the draft, so once the create settles the guard is off.
    box.setCreatePending(false);
    expect(h.guard.enabled).toBe(false);

    unmount();
  });
});
