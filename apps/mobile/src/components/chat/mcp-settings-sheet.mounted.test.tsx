/* eslint-disable max-lines -- the model, the render checks and the CRUD checks share one mock harness */
/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpSettingsSheet, useMcpSettings } from '@/components/chat/mcp-settings-sheet';
import { i18n } from '@/i18n';
import { type RemoteMcpServerState } from '@/lib/chat/remote-mcp';
import {
  type RemoteMcpServerDraft,
  type RemoteMcpServerPatch,
  type StoredRemoteMcpServer,
} from '@/lib/chat/remote-mcp-store';
import { chatPlaceOf } from '@/lib/chat/scope';
import { act, TestRenderer } from '@/test/renderer';

/**
 * The chat-tools sheet and the model behind it.
 *
 * Three things have to hold: the group switch moves the store and tells the
 * registry so an open chat's tool list moves with it; the Kilo row is the
 * per-chat switch alone, with no edit or delete; and a remote server is added,
 * edited and deleted through the one store, with a delete that never happens
 * without the confirmation. The Kilo switch's own failure handling is here too.
 */

const h = vi.hoisted(() => {
  const group = { value: true, listeners: new Set<() => void>() };
  const servers = { value: [] as StoredRemoteMcpServer[], listeners: new Set<() => void>() };
  const hasLoaded = { value: true };
  const discovered = { value: [] as RemoteMcpServerState[], listeners: new Set<() => void>() };
  const kilo = { value: { status: 'ready' as const, tools: [{}, {}, {}] } };
  const stores = { group, servers, discovered };
  const emit = (which: 'group' | 'servers' | 'discovered') => {
    for (const listener of stores[which].listeners) {
      listener();
    }
  };
  return {
    group,
    servers,
    hasLoaded,
    discovered,
    kilo,
    alert: vi.fn<(...args: unknown[]) => void>(),
    toastError: vi.fn(),
    setSettingsToolsEnabled: vi.fn((next: boolean) => {
      group.value = next;
      emit('group');
    }),
    setRemoteMcpServerEnabled: vi.fn((id: string, next: boolean) => {
      servers.value = servers.value.map(one => (one.id === id ? { ...one, enabled: next } : one));
      emit('servers');
    }),
    addRemoteMcpServer: vi.fn((draft: RemoteMcpServerDraft) => {
      servers.value = [...servers.value, { id: 'added', ...draft }];
      emit('servers');
    }),
    updateRemoteMcpServer: vi.fn((id: string, patch: RemoteMcpServerPatch) => {
      servers.value = servers.value.map(one => (one.id === id ? { ...one, ...patch } : one));
      emit('servers');
    }),
    deleteRemoteMcpServer: vi.fn((id: string) => {
      servers.value = servers.value.filter(one => one.id !== id);
      emit('servers');
    }),
    ensureRemoteMcp: vi.fn(),
    refreshChatTools: vi.fn(),
    setMcpEnabled: vi.fn(),
    retryKiloMcp: vi.fn(),
    mcpEnabledFor: vi.fn(),
    watchKiloMcp: vi.fn(() => () => undefined),
  };
});

vi.mock('@/lib/chat/settings-tools-switch', () => ({
  isSettingsToolsEnabled: () => h.group.value,
  subscribeSettingsToolsEnabled: (listener: () => void) => {
    h.group.listeners.add(listener);
    return () => {
      h.group.listeners.delete(listener);
    };
  },
  setSettingsToolsEnabled: h.setSettingsToolsEnabled,
}));

vi.mock('@/lib/chat/remote-mcp-store', () => ({
  listRemoteMcpServers: () => h.servers.value,
  getRemoteMcpServersHasLoaded: () => h.hasLoaded.value,
  subscribeRemoteMcpServers: (listener: () => void) => {
    h.servers.listeners.add(listener);
    return () => {
      h.servers.listeners.delete(listener);
    };
  },
  setRemoteMcpServerEnabled: h.setRemoteMcpServerEnabled,
  addRemoteMcpServer: h.addRemoteMcpServer,
  updateRemoteMcpServer: h.updateRemoteMcpServer,
  deleteRemoteMcpServer: h.deleteRemoteMcpServer,
}));

vi.mock('@/lib/chat/remote-mcp', () => ({
  remoteMcpState: () => h.discovered.value,
  subscribeRemoteMcp: (listener: () => void) => {
    h.discovered.listeners.add(listener);
    return () => {
      h.discovered.listeners.delete(listener);
    };
  },
  ensureRemoteMcp: h.ensureRemoteMcp,
}));

vi.mock('@/lib/chat/kilo-mcp', () => ({
  kiloMcpState: () => h.kilo.value,
  mcpEnabledFor: h.mcpEnabledFor,
  watchKiloMcp: h.watchKiloMcp,
}));

vi.mock('@/lib/chat/registry', () => ({
  refreshChatTools: h.refreshChatTools,
  retryKiloMcp: h.retryKiloMcp,
  setMcpEnabled: h.setMcpEnabled,
}));

vi.mock('react-native', () => ({
  Alert: { alert: h.alert },
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  View: 'View',
}));

vi.mock('sonner-native', () => ({ toast: { error: h.toastError } }));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: 'SessionPageSheet',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  Server: 'Server',
  SlidersHorizontal: 'SlidersHorizontal',
  Wrench: 'Wrench',
}));
vi.mock('@/components/ui/preference-row', () => ({ PreferenceRow: 'PreferenceRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/chat/remote-mcp-server-form', () => ({
  RemoteMcpServerForm: 'RemoteMcpServerForm',
}));

type Settings = ReturnType<typeof useMcpSettings>;

const held: { settings: Settings | undefined } = { settings: undefined };
const place = chatPlaceOf('u1', null);

function noop(): void {
  // The sheet's close is not what these checks are about.
}

function Harness({ sessionId }: { sessionId: string }) {
  const settings = useMcpSettings(place, sessionId);
  held.settings = settings;
  return createElement(McpSettingsSheet, { visible: true, onClose: noop, settings });
}

function server(id: string, overrides: Partial<StoredRemoteMcpServer> = {}): StoredRemoteMcpServer {
  return {
    id,
    name: `Server ${id}`,
    url: `https://${id}.example/mcp`,
    auth: { type: 'none' },
    enabled: true,
    ...overrides,
  };
}

function serverState(
  id: string,
  overrides: Partial<RemoteMcpServerState> = {}
): RemoteMcpServerState {
  return {
    id,
    name: `Server ${id}`,
    url: `https://${id}.example/mcp`,
    enabled: true,
    status: 'idle',
    toolCount: 0,
    retryable: false,
    ...overrides,
  };
}

let renderer: ReturnType<typeof TestRenderer.create> | undefined = undefined;

async function mount(): Promise<void> {
  renderer = TestRenderer.create(createElement(Harness, { sessionId: 's1' }));
  // The stored setting is read in an effect; let that read land before a tap.
  await flush();
}

/** Flushes the taps and the promise chains the handlers do not await. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function nodes(type: string): TestRenderer.ReactTestInstance[] {
  return renderer?.root.findAll(node => (node.type as string) === type) ?? [];
}

function texts(): string[] {
  return nodes('Text').flatMap(node =>
    typeof node.props.children === 'string' ? [node.props.children] : []
  );
}

function preferenceRow(title: string): TestRenderer.ReactTestInstance | undefined {
  return nodes('PreferenceRow').find(node => node.props.title === title);
}

function switchFor(label: string): TestRenderer.ReactTestInstance | undefined {
  return nodes('Switch').find(node => node.props.accessibilityLabel === label);
}

function buttonFor(label: string): TestRenderer.ReactTestInstance | undefined {
  return nodes('Button').find(
    button =>
      button.findAll(node => (node.type as string) === 'Text' && node.props.children === label)
        .length > 0
  );
}

/** The node, or a failure that says which one the sheet did not draw. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not rendered`);
  }
  return value;
}

async function tapSwitch(label: string, next: boolean): Promise<void> {
  await act(async () => {
    (required(switchFor(label), label).props.onValueChange as (value: boolean) => void)(next);
    await Promise.resolve();
  });
}

/** The Kilo and group switches are drawn by the (mocked) PreferenceRow. */
async function tapRow(title: string, next: boolean): Promise<void> {
  await act(async () => {
    (required(preferenceRow(title), title).props.onValueChange as (value: boolean) => void)(next);
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.group.value = true;
  h.servers.value = [];
  h.hasLoaded.value = true;
  h.discovered.value = [];
  h.kilo.value = { status: 'ready', tools: [{}, {}, {}] };
  h.mcpEnabledFor.mockResolvedValue(true);
  h.setMcpEnabled.mockResolvedValue(undefined);
  h.retryKiloMcp.mockResolvedValue(undefined);
  h.refreshChatTools.mockResolvedValue(undefined);
  h.ensureRemoteMcp.mockResolvedValue([]);
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  held.settings = undefined;
  vi.clearAllMocks();
});

describe('the Kilo MCP switch', () => {
  it('keeps the new position when the write and the move land', async () => {
    await mount();

    await tapRow('Use Kilo tools', false);

    expect(held.settings?.view.enabled).toBe(false);
    expect(h.setMcpEnabled).toHaveBeenCalledWith('s1', false);
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('goes back and says why when the chat cannot be moved', async () => {
    h.setMcpEnabled.mockRejectedValue(new Error('the chat could not be moved'));
    await mount();

    await tapRow('Use Kilo tools', false);

    expect(held.settings?.view.enabled).toBe(true);
    expect(h.toastError).toHaveBeenCalledWith('the chat could not be moved');
  });

  it('says something went wrong when the failure carries no reason', async () => {
    h.setMcpEnabled.mockRejectedValue('no reason');
    await mount();

    await tapRow('Use Kilo tools', false);

    expect(held.settings?.view.enabled).toBe(true);
    expect(h.toastError).toHaveBeenCalledWith(i18n.t('common.somethingWentWrong'));
  });

  it('drops a setting that answers late for the session that left', async () => {
    const left = Promise.withResolvers<boolean>();
    const arrived = Promise.withResolvers<boolean>();
    h.mcpEnabledFor.mockReturnValueOnce(left.promise).mockReturnValueOnce(arrived.promise);

    renderer = TestRenderer.create(createElement(Harness, { sessionId: 's1' }));
    // The first session's read is in flight and must not be flushed yet.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      renderer?.update(createElement(Harness, { sessionId: 's2' }));
      await Promise.resolve();
    });
    await act(async () => {
      arrived.resolve(true);
      await Promise.resolve();
    });
    await act(async () => {
      left.resolve(false);
      await Promise.resolve();
    });

    expect(h.mcpEnabledFor).toHaveBeenCalledWith('s1');
    expect(h.mcpEnabledFor).toHaveBeenCalledWith('s2');
    expect(held.settings?.view.enabled).toBe(true);
  });

  it('says why when the Retry itself fails', async () => {
    h.retryKiloMcp.mockRejectedValue(new Error('the chat could not be moved'));
    await mount();

    await act(async () => {
      held.settings?.retry();
      await Promise.resolve();
    });

    expect(h.toastError).toHaveBeenCalledWith('the chat could not be moved');
    expect(held.settings?.retrying).toBe(false);
  });

  it('says something went wrong when the Retry failure carries no reason', async () => {
    h.retryKiloMcp.mockRejectedValue('no reason');
    await mount();

    await act(async () => {
      held.settings?.retry();
      await Promise.resolve();
    });

    expect(h.toastError).toHaveBeenCalledWith(i18n.t('common.somethingWentWrong'));
  });
});

describe('the chat-tools sheet', () => {
  it('moves the group switch and tells the registry the tool list changed', async () => {
    await mount();
    expect(preferenceRow('Let Kilo change app settings')?.props.value).toBe(true);

    await tapRow('Let Kilo change app settings', false);

    expect(h.setSettingsToolsEnabled).toHaveBeenCalledWith(false);
    expect(h.refreshChatTools).toHaveBeenCalled();
    // The row reads the store, so it moved with the write.
    expect(preferenceRow('Let Kilo change app settings')?.props.value).toBe(false);
  });

  it('draws the Kilo row with no edit or delete control', async () => {
    await mount();

    expect(preferenceRow('Use Kilo tools')).toBeDefined();
    expect(texts()).toContain(
      'Built in. Turn it on or off for this chat; it cannot be edited or deleted.'
    );
    expect(buttonFor('Edit server')).toBeUndefined();
    expect(buttonFor('Delete server')).toBeUndefined();
  });

  it('shows the empty state and the way to add one when no server was added', async () => {
    await mount();

    const empty = nodes('EmptyState')[0];
    expect(empty?.props.title).toBe('No remote servers yet');
    expect(empty?.props.description).toBe('Add one to offer its tools in your chats.');
    expect(buttonFor('Add MCP server')).toBeDefined();
  });

  it('draws a skeleton instead of the empty state while the list is still being read', async () => {
    h.hasLoaded.value = false;
    await mount();

    expect(nodes('Skeleton').length).toBeGreaterThan(0);
    expect(nodes('EmptyState')).toHaveLength(0);
    // The way to add one belongs to the section, so the wait never hides it.
    expect(buttonFor('Add MCP server')).toBeDefined();
  });

  it('retries a failed server through the discovery when its Retry is pressed', async () => {
    h.servers.value = [server('alpha')];
    h.discovered.value = [serverState('alpha', { status: 'failed', retryable: true })];
    const pending = Promise.withResolvers<readonly RemoteMcpServerState[]>();
    h.ensureRemoteMcp.mockReturnValue(pending.promise);
    await mount();

    const retry = required(buttonFor('Retry'), 'Retry');
    await act(async () => {
      (retry.props.onPress as () => void)();
      await Promise.resolve();
    });

    expect(h.ensureRemoteMcp).toHaveBeenCalledWith(place, { retry: true });
    // The busy flag is that row's, so the person can see the ask they made.
    expect(required(buttonFor('Retry'), 'Retry').props.loading).toBe(true);

    await act(async () => {
      pending.resolve([]);
      await Promise.resolve();
    });
    await flush();

    expect(required(buttonFor('Retry'), 'Retry').props.loading).toBe(false);
    // The chat's tool list has to move onto what the Retry just found.
    expect(h.refreshChatTools).toHaveBeenCalled();
  });

  it('turns a server off for the chats and tells the registry', async () => {
    h.servers.value = [server('alpha')];
    await mount();
    // The row's switch names its server, so two rows read apart.
    const label = i18n.t('modelChat.mcp.enableServer', { name: 'Server alpha' });
    expect(switchFor(label)?.props.value).toBe(true);

    await tapSwitch(label, false);

    expect(h.setRemoteMcpServerEnabled).toHaveBeenCalledWith('alpha', false);
    expect(h.refreshChatTools).toHaveBeenCalled();
    expect(switchFor(label)?.props.value).toBe(false);
  });

  it('adds a server through the store and discovers it when the form is saved', async () => {
    await mount();

    await act(async () => {
      (required(buttonFor('Add MCP server'), 'Add MCP server').props.onPress as () => void)();
      await Promise.resolve();
    });
    const form = required(nodes('RemoteMcpServerForm')[0], 'RemoteMcpServerForm');
    expect(form.props.server).toBeUndefined();

    const draft: RemoteMcpServerDraft = {
      name: 'Remote',
      url: 'https://remote.example/mcp',
      auth: { type: 'none' },
      enabled: true,
    };
    await act(async () => {
      (form.props.onSave as (next: RemoteMcpServerDraft) => void)(draft);
      await Promise.resolve();
    });
    await flush();

    expect(h.addRemoteMcpServer).toHaveBeenCalledWith(draft);
    expect(h.ensureRemoteMcp).toHaveBeenCalledWith(place, { retry: true });
    expect(h.refreshChatTools).toHaveBeenCalled();
  });

  it('edits the server the row names through the store', async () => {
    h.servers.value = [server('alpha')];
    await mount();

    await act(async () => {
      (required(buttonFor('Edit server'), 'Edit server').props.onPress as () => void)();
      await Promise.resolve();
    });
    const form = required(nodes('RemoteMcpServerForm')[0], 'RemoteMcpServerForm');
    expect(form.props.server).toMatchObject({ id: 'alpha', name: 'Server alpha' });

    const draft: RemoteMcpServerDraft = {
      name: 'Renamed',
      url: 'https://alpha.example/mcp',
      auth: { type: 'none' },
      enabled: true,
    };
    await act(async () => {
      (form.props.onSave as (next: RemoteMcpServerDraft) => void)(draft);
      await Promise.resolve();
    });
    await flush();

    expect(h.updateRemoteMcpServer).toHaveBeenCalledWith('alpha', draft);
    expect(h.ensureRemoteMcp).toHaveBeenCalledWith(place, { retry: true });
  });

  it('asks before deleting a server and deletes only on the destructive choice', async () => {
    h.servers.value = [server('alpha')];
    await mount();

    await act(async () => {
      (required(buttonFor('Delete server'), 'Delete server').props.onPress as () => void)();
      await Promise.resolve();
    });

    const call = h.alert.mock.calls.at(0);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(call?.[0]).toBe('Delete this server?');
    expect(call?.[1]).toBe('Its tools leave every chat.');
    const buttons = call?.[2] as { style?: string; onPress?: () => void }[] | undefined;
    expect(h.deleteRemoteMcpServer).not.toHaveBeenCalled();

    await act(async () => {
      buttons?.find(button => button.style === 'cancel')?.onPress?.();
      await Promise.resolve();
    });
    expect(h.deleteRemoteMcpServer).not.toHaveBeenCalled();

    await act(async () => {
      buttons?.find(button => button.style === 'destructive')?.onPress?.();
      await Promise.resolve();
    });
    await flush();

    expect(h.deleteRemoteMcpServer).toHaveBeenCalledWith('alpha');
  });
});
