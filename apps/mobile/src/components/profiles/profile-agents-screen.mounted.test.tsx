import { type Href } from 'expo-router';
/* eslint-disable max-lines -- one mounted harness pins the mode badge, draft restore, save ownership, row layout, manage slot, and delete confirmation */
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { MAX_PROFILE_AGENTS } from '@/lib/agent-profile-forms';
import { resetFormDraftsForTests } from '@/lib/form-draft';
import { isolateBidiText } from '@/lib/bidi';
import { ProfileAgentsScreen } from '@/components/profiles/profile-agents-screen';
import { type AgentSource } from '@/components/profiles/profile-agents-model';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/** The default destination the Profile tab's routes pass: their own Profiles list. */
const PROFILES_LIST_HREF = '/(app)/(tabs)/(3_profile)/profiles' as Href;

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  permission: 'allowed' as 'resolving' | 'allowed' | 'read-only',
  connectivity: 'online' as string,
  query: {
    data: undefined as AgentSource[] | undefined,
    error: undefined as unknown,
    isError: false,
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    createAgent: { mutateAsync: vi.fn(), isPending: false },
    updateAgent: { mutateAsync: vi.fn(), isPending: false },
    deleteAgent: { mutateAsync: vi.fn(), isPending: false },
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileAgents: () => h.query,
  useAgentProfileOverview: () => ({ data: { name: 'Team profile' } }),
  useAgentProfileSectionMutations: () => h.mutations,
}));
vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useOrganizationProfilePermission: () => h.permission,
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => h.connectivity,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000', destructive: '#FF0000' }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({
  StateAction: 'StateAction',
  // The real state renders its action inside its body, so the slot that stands in
  // for the add action belongs to the tree; the stub keeps only that slot.
  EmptyState: (props: { action?: ReactNode }) => props.action,
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  Pencil: 'Pencil',
  Trash2: 'Trash2',
  Plus: 'Plus',
}));
vi.mock('@/components/profiles/agent-form-sheet', async () => {
  // vi.mock factories are hoisted above this module's imports, so the React,
  // i18n and draft helpers load inside the factory. The stand-in keeps the
  // screen's props on its host element and renders the two fields whose text the
  // sheet's own draft holds (`agent-form-sheet.tsx` writes `slug` and `name`),
  // so a case can type into them and read what a remount restores.
  const { createElement: create } = await import('react');
  const { i18n: translate } = await import('@/i18n');
  const { useFormDraftRef } = await import('@/lib/form-draft');
  function AgentFormSheet(props: { draftScope?: string }) {
    const slugRef = useFormDraftRef(props.draftScope, 'slug', '');
    const nameRef = useFormDraftRef(props.draftScope, 'name', '');
    return create(
      'AgentFormSheet',
      props,
      create('FormField', {
        key: 'slug',
        label: translate.t('profiles.agents.slug'),
        defaultValue: slugRef.current,
        onChangeText: (value: string) => {
          slugRef.current = value;
        },
      }),
      create('FormField', {
        key: 'name',
        label: translate.t('profiles.agents.name'),
        defaultValue: nameRef.current,
        onChangeText: (value: string) => {
          nameRef.current = value;
        },
      })
    );
  }
  return { AgentFormSheet };
});

function agent(id: string, mode: AgentSource['config']['mode']): AgentSource {
  return { id, slug: id, name: id, config: mode === undefined ? {} : { mode } };
}

/** How many form sheets the screen currently renders. */
function sheetCount(root: ReactTestInstance): number {
  return root.findAll(node => String(node.type) === 'AgentFormSheet').length;
}

/** Press the row control whose accessibility label starts with `prefix`. */
function pressRow(root: ReactTestInstance, prefix: string): void {
  const control = root.findAll(
    node =>
      String(node.type) === 'Pressable' &&
      typeof node.props.onPress === 'function' &&
      String(node.props.accessibilityLabel).startsWith(prefix)
  )[0];
  // The test renderer exposes host props untyped; the screen passes this handler.
  const onPress = control?.props.onPress as (() => void) | undefined;
  act(() => {
    onPress?.();
  });
}

describe('ProfileAgentsScreen mode badge', () => {
  it('renders the localized short label for every visibility mode', async () => {
    await i18n.changeLanguage('hi');
    h.query.data = [agent('alpha', 'primary'), agent('beta', 'subagent'), agent('gamma', 'all')];
    const { renderer, unmount } = await mountScreen();

    const labels = renderer.root
      .findAll(node => String(node.type) === 'Text')
      .filter(node => node.props.variant === 'caption')
      .map(node => node.props.children as string);

    expect(labels).toEqual([
      i18n.t('profiles.agents.modePrimary'),
      i18n.t('profiles.agents.modeSubagent'),
      i18n.t('profiles.agents.modeAll'),
    ]);
    expect(labels).not.toContain('primary');
    expect(new Set(labels).size).toBe(3);

    unmount();
    await i18n.changeLanguage('en');
  });

  it('falls back to the primary mode label when the config carries none', async () => {
    await i18n.changeLanguage('hi');
    h.query.data = [agent('alpha', undefined)];
    const { renderer, unmount } = await mountScreen();

    const labels = renderer.root
      .findAll(node => String(node.type) === 'Text')
      .filter(node => node.props.variant === 'caption')
      .map(node => node.props.children as string);

    expect(labels).toEqual([i18n.t('profiles.agents.modePrimary')]);

    unmount();
    await i18n.changeLanguage('en');
  });

  it('announces the agent identity before its controls', async () => {
    h.query.data = [agent('alpha', 'primary')];
    const { renderer, unmount } = await mountScreen();

    const identity = renderer.root.findAll(
      node => String(node.type) === 'View' && node.props.accessibilityRole === 'text'
    )[0];

    expect(identity?.props.accessibilityLabel).toBe('alpha, Primary only');
    expect(identity?.props.accessible).toBe(true);

    unmount();
  });

  it('drops the row presses of the burst that closed the sheet', async () => {
    h.query.data = [agent('alpha', 'primary')];
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, 'Edit');
    const sheet = renderer.root.find(node => String(node.type) === 'AgentFormSheet');
    // The test renderer exposes host props untyped; the screen passes this handler.
    const closeSheet = sheet.props.onClose as () => void;
    act(() => {
      closeSheet();
    });

    pressRow(renderer.root, 'Delete');
    pressRow(renderer.root, 'Edit');

    expect(sheetCount(renderer.root)).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();

    unmount();
  });
});

type PressableProps = { onPress: () => void; onClose?: () => void };

/** Fire one handler a host stub carries; the stubs keep props untyped. */
function press(node: { props: unknown }): void {
  const props = node.props as PressableProps;
  act(() => {
    props.onPress();
  });
}

function pressClose(sheet: { props: unknown }): void {
  const props = sheet.props as PressableProps;
  const onClose = props.onClose;
  if (typeof onClose !== 'function') {
    throw new TypeError('the sheet rendered no onClose');
  }
  act(() => {
    onClose();
  });
}

describe('ProfileAgentsScreen form draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
  });

  it('reopens the add sheet after a remount', async () => {
    h.query.data = [agent('alpha', 'primary')];
    const first = await mountScreen();
    const addButton = first.renderer.root.findAll(node => String(node.type) === 'Button')[0];
    if (!addButton) {
      throw new Error('the add button was not rendered');
    }
    press(addButton);
    expect(
      first.renderer.root.findAll(node => String(node.type) === 'AgentFormSheet')
    ).toHaveLength(1);
    first.unmount();

    const second = await mountScreen();
    expect(
      second.renderer.root.findAll(node => String(node.type) === 'AgentFormSheet')
    ).toHaveLength(1);
    second.unmount();
  });

  it('keeps the add sheet closed after the form was cancelled', async () => {
    h.query.data = [agent('alpha', 'primary')];
    const first = await mountScreen();
    const addButton = first.renderer.root.findAll(node => String(node.type) === 'Button')[0];
    if (!addButton) {
      throw new Error('the add button was not rendered');
    }
    press(addButton);
    const sheet = first.renderer.root.findAll(node => String(node.type) === 'AgentFormSheet')[0];
    if (!sheet) {
      throw new Error('the sheet was not rendered');
    }
    pressClose(sheet);
    first.unmount();

    const second = await mountScreen();
    expect(
      second.renderer.root.findAll(node => String(node.type) === 'AgentFormSheet')
    ).toHaveLength(0);
    second.unmount();
  });
});

type MountedRenderer = Awaited<ReturnType<typeof renderWithProviders>>['renderer'];

/** The nodes of one host type; the stubs keep their props untyped. */
function nodesOfType(renderer: MountedRenderer, type: string) {
  return renderer.root.findAll(node => String(node.type) === type);
}

/** Mount the agents screen against this test's query and permission state. */
function mountScreen() {
  return renderWithProviders(
    createElement(ProfileAgentsScreen, { profileId: 'profile-1', backFallback: PROFILES_LIST_HREF })
  );
}

/** The open sheet, which the screen wires to its own save pipeline. */
function openSheet(renderer: MountedRenderer) {
  const sheet = nodesOfType(renderer, 'AgentFormSheet')[0];
  if (!sheet) {
    throw new Error('the sheet was not rendered');
  }
  return sheet;
}

function pressAdd(renderer: MountedRenderer): void {
  const button = nodesOfType(renderer, 'Button')[0];
  if (!button) {
    throw new Error('the add button was not rendered');
  }
  act(() => {
    (button.props as { onPress: () => void }).onPress();
  });
}

/** The props one sheet field stub carries; the renderer keeps them untyped. */
type FieldProps = { defaultValue?: string; onChangeText?: (text: string) => void };

/** The sheet field the stub renders under `label`. */
function findField(renderer: MountedRenderer, label: string) {
  const field = nodesOfType(renderer, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

/** Type into one sheet field, which writes the scope's draft as the sheet does. */
function changeText(renderer: MountedRenderer, label: string, value: string): void {
  const field = findField(renderer, label).props as FieldProps;
  act(() => {
    field.onChangeText?.(value);
  });
}

/** Re-render the mounted screen against fresh mock state, keeping the providers. */
function rerenderScreen(renderer: MountedRenderer, queryClient: QueryClient): void {
  renderer.update(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProfileAgentsScreen, {
        profileId: 'profile-1',
        backFallback: PROFILES_LIST_HREF,
      })
    )
  );
}

describe('ProfileAgentsScreen save ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    h.query.data = [agent('alpha', 'primary')];
    h.query.isPending = false;
  });

  it('leaves the form opened after a refused save alone when that save settles', async () => {
    const pendingSave = Promise.withResolvers<unknown>();
    h.mutations.createAgent.mutateAsync.mockImplementation(() => pendingSave.promise);

    const { renderer, unmount } = await mountScreen();
    pressAdd(renderer);
    const first = openSheet(renderer);
    act(() => {
      (first.props.onSave as (payload: unknown) => void)({
        slug: 'first-agent',
        name: 'First agent',
        config: {},
      });
    });
    expect(h.mutations.createAgent.mutateAsync).toHaveBeenCalledTimes(1);

    // Dismiss that attempt and open a different form: the refusal of the first
    // save belongs to the first form and must not appear under the second.
    act(() => {
      (first.props.onClose as () => void)();
    });
    pressAdd(renderer);
    const second = openSheet(renderer);

    await act(async () => {
      pendingSave.reject({ data: { code: 'CONFLICT' } });
      await Promise.resolve();
    });

    expect(second.props.saveFailure).toBeNull();
    expect(nodesOfType(renderer, 'AgentFormSheet')).toHaveLength(1);
    unmount();
  });
});

describe('ProfileAgentsScreen agent row layout', () => {
  it('keeps the mode label off the name row', async () => {
    h.query.data = [agent('Alpha', 'subagent')];
    const { renderer, unmount } = await mountScreen();

    const texts = renderer.root.findAll(node => String(node.type) === 'Text');
    const nameText = texts.find(node => node.props.children === 'Alpha');
    const label = texts.find(node => node.props.variant === 'caption');
    if (nameText === undefined || label === undefined) {
      throw new Error('the row rendered no name or no mode label');
    }

    // A label beside the name takes the width a short name needs, so the row
    // would ellipsize "Alpha". The label belongs to the column under the name:
    // the name owns the column's first line and the mode label the next one.
    const column = nameText.parent;
    if (column === null) {
      throw new Error('the name has no column');
    }
    const lines = column.children.filter(
      (child): child is ReactTestInstance => typeof child !== 'string'
    );
    expect(label.parent).toBe(column);
    expect(lines[0]).toBe(nameText);
    expect(lines[1]).toBe(label);

    unmount();
  });
});

/** The visible strings of one mounted tree, in render order. */
function screenTexts(renderer: MountedRenderer): unknown[] {
  return nodesOfType(renderer, 'Text').map(node => node.props.children);
}

describe('ProfileAgentsScreen manage slot', () => {
  beforeEach(() => {
    resetFormDraftsForTests();
  });

  it('empty list: a member reads who may change the profile instead of an add action', async () => {
    h.permission = 'read-only';
    h.query.data = [];
    const { renderer, unmount } = await mountScreen();

    expect(screenTexts(renderer)).toContain(i18n.t('profiles.organizationRoleRequired'));
    expect(nodesOfType(renderer, 'Button')).toHaveLength(0);

    unmount();
  });

  it('populated list: a member gets the sentence and no add action or row control', async () => {
    h.permission = 'read-only';
    h.query.data = [agent('alpha', 'primary')];
    const { renderer, unmount } = await mountScreen();

    expect(screenTexts(renderer)).toContain(i18n.t('profiles.organizationRoleRequired'));
    expect(nodesOfType(renderer, 'Button')).toHaveLength(0);
    expect(nodesOfType(renderer, 'Pressable')).toHaveLength(0);

    unmount();
  });

  it('an unresolved role shows neither the action nor the sentence', async () => {
    h.permission = 'resolving';
    h.query.data = [];
    const { renderer, unmount } = await mountScreen();

    expect(screenTexts(renderer)).not.toContain(i18n.t('profiles.organizationRoleRequired'));
    expect(nodesOfType(renderer, 'Button')).toHaveLength(0);

    unmount();
  });
});

/** The agent name the fixture row holds; the dialog must isolate exactly this run. */
const AGENT_NAME = 'alpha';

/** The confirm sheet's request, as the screen hands it to `useConfirmDialog`. */
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

/** Read the request the screen raised, without answering it. */
function deleteRequest(): ConfirmRequest {
  const request = h.confirm.mock.calls[0]?.[0] as ConfirmRequest | undefined;
  if (!request) {
    throw new Error('the screen asked for no confirmation');
  }
  return request;
}

describe('ProfileAgentsScreen delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    h.permission = 'allowed';
    h.query.data = [agent(AGENT_NAME, 'primary')];
    h.query.isError = false;
    h.query.isPending = false;
    h.query.isRefetching = false;
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
  });

  // The dialog used to read "Delete" as both its title and its confirm label,
  // with the bare name as the message, so the reader was never told what
  // removing the agent would do.
  it('asks for consent with the agent name in the title and states the consequence', async () => {
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, 'Delete');
    const request = deleteRequest();

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(request).toMatchObject({
      title: i18n.t('profiles.agents.deleteTitle', { name: isolateBidiText(AGENT_NAME) }),
      message: i18n.t('profiles.agents.deleteMessage'),
      confirmLabel: i18n.t('profiles.agents.deleteConfirm'),
    });
    expect(request.confirmLabel).not.toBe(i18n.t('common.delete'));
    expect(request.title).not.toBe(request.message);
    expect(request.title).not.toBe(AGENT_NAME);
    expect(request.message).not.toBe(AGENT_NAME);

    unmount();
  });

  // An agent name is user prose, so its own first strong character picks the
  // direction: one first-strong isolate pair, no more.
  it('keeps the agent name in exactly one first-strong isolate pair', async () => {
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, 'Delete');
    const { title } = deleteRequest();

    expect(title).toContain(`\u2068${AGENT_NAME}\u2069`);
    expect(title.split('\u2068')).toHaveLength(2);
    expect(title.split('\u2069')).toHaveLength(2);
    expect(title).not.toContain('\u2066');

    unmount();
  });

  it('deletes nothing until the reader confirms, then deletes that agent', async () => {
    h.mutations.deleteAgent.mutateAsync.mockResolvedValue({ success: true });
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, 'Delete');
    const request = deleteRequest();

    expect(h.mutations.deleteAgent.mutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      request.onConfirm();
      await Promise.resolve();
    });

    expect(h.mutations.deleteAgent.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutations.deleteAgent.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      agentId: AGENT_NAME,
    });

    unmount();
  });
});

/** The translated cap line, as the footer renders it. */
function capMessage(): string {
  return i18n.t('profiles.agents.limitReached', { max: MAX_PROFILE_AGENTS });
}

/** `length` distinct agents, so the list holds exactly the count the server caps. */
function agentsAt(length: number): AgentSource[] {
  return Array.from({ length }, (_, index) => agent(`agent-${index}`, 'primary'));
}

describe('ProfileAgentsScreen agent cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    h.permission = 'allowed';
    h.query.isError = false;
    h.query.isPending = false;
    h.query.isRefetching = false;
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
  });

  it('states the cap above the Add action and disables it at the cap', async () => {
    h.query.data = agentsAt(MAX_PROFILE_AGENTS);
    const { renderer, unmount } = await mountScreen();

    // One pre-order walk, so the indexes compare the footer's own order.
    const ordered = renderer.root.findAll(
      node => String(node.type) === 'Text' || String(node.type) === 'Button'
    );
    const noticeIndex = ordered.findIndex(node => node.props.children === capMessage());
    const addIndex = ordered.findIndex(node => String(node.type) === 'Button');

    expect(noticeIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(addIndex);
    expect(ordered[noticeIndex]?.props.className).toContain('text-warn');
    expect(nodesOfType(renderer, 'Button')[0]?.props.disabled).toBe(true);

    unmount();
  });

  it('offers the Add action without a notice one agent below the cap', async () => {
    h.query.data = agentsAt(MAX_PROFILE_AGENTS - 1);
    const { renderer, unmount } = await mountScreen();

    expect(screenTexts(renderer)).not.toContain(capMessage());
    expect(nodesOfType(renderer, 'Button')[0]?.props.disabled).toBe(false);

    unmount();
  });

  it('reports a create the cap refuses as the cap line, not a generic failure', async () => {
    h.query.data = [agent('alpha', 'primary')];
    h.mutations.createAgent.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Profiles are limited to 20 agents'), {
        data: { code: 'PRECONDITION_FAILED' },
      })
    );

    const { renderer, unmount } = await mountScreen();
    pressAdd(renderer);
    const sheet = openSheet(renderer);
    await act(async () => {
      (sheet.props.onSave as (payload: unknown) => void)({
        slug: 'beta',
        name: 'Beta',
        config: {},
      });
      await Promise.resolve();
    });

    expect(openSheet(renderer).props.saveFailure).toEqual({ kind: 'limit' });

    unmount();
  });

  it('reports any other refused create as a generic failure', async () => {
    h.query.data = [agent('alpha', 'primary')];
    h.mutations.createAgent.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Internal server error'), { data: { code: 'INTERNAL_SERVER_ERROR' } })
    );

    const { renderer, unmount } = await mountScreen();
    pressAdd(renderer);
    const sheet = openSheet(renderer);
    await act(async () => {
      (sheet.props.onSave as (payload: unknown) => void)({
        slug: 'beta',
        name: 'Beta',
        config: {},
      });
      await Promise.resolve();
    });

    expect(openSheet(renderer).props.saveFailure).toEqual({ kind: 'refused' });

    unmount();
  });
});

/** A sheet draft typed while the role allowed the write; the store keeps it past an unmount. */
async function seedSheetDraft(): Promise<void> {
  const first = await mountScreen();
  pressAdd(first.renderer);
  changeText(first.renderer, i18n.t('profiles.agents.slug'), 'portal-agent');
  changeText(first.renderer, i18n.t('profiles.agents.name'), 'Portal agent');
  first.unmount();
}

describe('ProfileAgentsScreen manage permission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    h.permission = 'allowed';
    h.query.data = [agent('alpha', 'primary')];
    h.query.isError = false;
    h.query.isPending = false;
    h.query.isRefetching = false;
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
  });

  it('renders no sheet for a stored draft once the role is read-only, and states the role once', async () => {
    await seedSheetDraft();
    h.permission = 'read-only';

    const { renderer, unmount } = await mountScreen();

    expect(nodesOfType(renderer, 'AgentFormSheet')).toHaveLength(0);
    expect(
      screenTexts(renderer).filter(text => text === i18n.t('profiles.organizationRoleRequired'))
    ).toHaveLength(1);

    unmount();
  });

  it('drops that draft with the denial, so a later allowed render stays closed', async () => {
    await seedSheetDraft();
    h.permission = 'read-only';

    const denied = await mountScreen();
    expect(nodesOfType(denied.renderer, 'AgentFormSheet')).toHaveLength(0);
    denied.unmount();

    h.permission = 'allowed';
    const allowed = await mountScreen();
    expect(nodesOfType(allowed.renderer, 'AgentFormSheet')).toHaveLength(0);
    allowed.unmount();
  });

  it('keeps the draft while the role resolves, then reopens on the typed fields', async () => {
    await seedSheetDraft();
    h.permission = 'resolving';

    const resolving = await mountScreen();
    expect(nodesOfType(resolving.renderer, 'AgentFormSheet')).toHaveLength(0);

    h.permission = 'allowed';
    await act(async () => {
      rerenderScreen(resolving.renderer, resolving.queryClient);
      await Promise.resolve();
    });

    expect(nodesOfType(resolving.renderer, 'AgentFormSheet')).toHaveLength(1);
    const slug = findField(resolving.renderer, i18n.t('profiles.agents.slug')).props as FieldProps;
    const name = findField(resolving.renderer, i18n.t('profiles.agents.name')).props as FieldProps;
    expect(slug.defaultValue).toBe('portal-agent');
    expect(name.defaultValue).toBe('Portal agent');

    resolving.unmount();
  });

  it('closes the open sheet when the role is denied and does not reopen it when it returns', async () => {
    const { renderer, queryClient, unmount } = await mountScreen();
    pressAdd(renderer);
    expect(nodesOfType(renderer, 'AgentFormSheet')).toHaveLength(1);
    changeText(renderer, i18n.t('profiles.agents.slug'), 'portal-agent');

    h.permission = 'read-only';
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });
    expect(nodesOfType(renderer, 'AgentFormSheet')).toHaveLength(0);

    h.permission = 'allowed';
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });
    expect(nodesOfType(renderer, 'AgentFormSheet')).toHaveLength(0);

    unmount();
  });
});

/** The props the mocked `QueryError` host element carries; the renderer keeps them untyped. */
type RenderedQueryError = {
  variant?: string;
  title?: string;
  placement?: string;
  onRetry?: () => void;
};

describe('ProfileAgentsScreen load errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    h.permission = 'allowed';
    h.connectivity = 'online';
    Object.assign(h.query, {
      data: undefined,
      error: undefined,
      isError: false,
      isPending: false,
      isRefetching: false,
    });
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
  });

  it('forbidden: names the permission state and offers no Retry', async () => {
    Object.assign(h.query, {
      isError: true,
      error: { data: { code: 'FORBIDDEN' } },
    });

    const { renderer, unmount } = await mountScreen();

    // The renderer keeps host props untyped; the stub's props are the screen's own.
    const queryError = nodesOfType(renderer, 'QueryError')[0]?.props as
      | RenderedQueryError
      | undefined;
    expect(queryError?.variant).toBe('permission');
    expect(queryError?.title).toBeUndefined();
    expect(queryError?.onRetry).toBeUndefined();
    // A read with nothing under it owns the surface, so it centres and no
    // scroller wraps it.
    expect(queryError?.placement).toBe('center');
    expect(nodesOfType(renderer, 'ScrollView')).toHaveLength(0);
    expect(nodesOfType(renderer, 'TabScrollView')).toHaveLength(0);

    unmount();
  });

  it('server: keeps the load-failure title and a Retry that refetches', async () => {
    Object.assign(h.query, {
      isError: true,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });

    const { renderer, unmount } = await mountScreen();

    const queryError = nodesOfType(renderer, 'QueryError')[0]?.props as
      | RenderedQueryError
      | undefined;
    expect(queryError?.variant).toBe('server');
    expect(queryError?.title).toBe("Couldn't load profiles");
    expect(typeof queryError?.onRetry).toBe('function');
    act(() => {
      queryError?.onRetry?.();
    });
    expect(h.query.refetch).toHaveBeenCalledTimes(1);

    unmount();
  });
});
