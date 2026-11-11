/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- DOM globals precede loading the preview. */
import { createRequire } from 'node:module';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  NativePresenceConnection,
  NativePresenceState,
  NativeSessionState,
  StoredMessage,
} from '@kilocode/cloud-agent-sdk';
import type * as NativeDiscovery from '@kilocode/cloud-agent-sdk/native-sync-discovery';
import type * as NativeSource from '@kilocode/cloud-agent-sdk/native-conversation-source';

const requireFromHere = createRequire(__filename);
const { parseHTML } = requireFromHere('linkedom') as {
  parseHTML: (html: string) => { window: typeof globalThis; document: Document };
};
const dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
Object.assign(globalThis, {
  React: requireFromHere('react'),
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
let mockOrganizationID: string | null = null;
const mockConnections: NativePresenceConnection[] = [];
const mockCommand = jest.fn();
const mockListSessions = jest.fn();
const mockSessionListeners: ((state: NativeSessionState) => void)[] = [];
const mockSessionClose = jest.fn();
const mockConnectSession = jest.fn(
  (_sessionID: string, listener: (state: NativeSessionState) => void) => {
    mockSessionListeners.push(listener);
    return { close: mockSessionClose };
  }
);
const mockTranscript = jest.fn((_props: { messages: StoredMessage[] }) => null);
const mockConnectPresence = jest.fn((listener: (state: NativePresenceState) => void) => {
  const connection = { command: mockCommand, close: jest.fn() };
  mockConnections.push(connection);
  listener({
    connection: 'connected',
    instances: [
      {
        instanceID: 'host',
        tenant: { type: 'organization', id: mockOrganizationID ?? 'personal' },
        online: true,
        advertisement: { name: 'Owned host', projectName: 'Fixture', kind: 'remote', sessions: [] },
      },
    ],
  });
  return connection;
});
jest.mock('@/hooks/useUrlOrganizationId', () => ({
  useUrlOrganizationId: () => mockOrganizationID,
}));
jest.mock('@/components/ui/button', () => ({ Button: 'button' }));
jest.mock('@/components/ui/input', () => ({ Input: 'input' }));
jest.mock('@/components/ui/textarea', () => ({ Textarea: 'textarea' }));
jest.mock('@/components/cloud-agent-next/assistant-ui/CloudThread', () => ({
  CloudReadOnlyThread: (props: { messages: StoredMessage[] }) => mockTranscript(props),
}));
jest.mock('@kilocode/cloud-agent-sdk', () => ({
  readNativeConversation: jest.requireActual<typeof NativeSource>(
    '@kilocode/cloud-agent-sdk/native-conversation-source'
  ).readNativeConversation,
  listNativeModels: jest.requireActual<typeof NativeDiscovery>(
    '@kilocode/cloud-agent-sdk/native-sync-discovery'
  ).listNativeModels,
  NativeSyncClient: jest.fn(() => ({
    connectPresence: mockConnectPresence,
    listSessions: mockListSessions,
    connectSession: mockConnectSession,
  })),
}));
const { default: NativeRemotePreview } = require('./NativeRemotePreview') as {
  default: () => ReactElement;
};
let root: Root;
let queryClient: QueryClient;

function render() {
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(NativeRemotePreview)
      )
    )
  );
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5);
    });
  }
  throw new Error('Native preview did not reach the expected state');
}
async function chooseHost() {
  const select = dom.document.querySelector('select');
  if (!select) throw new Error('Missing host selector');
  Object.defineProperty(select, 'value', { configurable: true, writable: true, value: 'host' });
  await act(() => {
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}
function reply(result: unknown) {
  return {
    commandID: 'command',
    instanceID: 'host',
    status: 'replied',
    body: { status: 'succeeded', result },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockOrganizationID = 'org-owned';
  mockConnections.length = 0;
  mockConnectPresence.mockClear();
  mockCommand.mockReset();
  mockListSessions.mockReset().mockResolvedValue({ items: [], cursor: null });
  mockSessionListeners.length = 0;
  mockConnectSession.mockClear();
  mockSessionClose.mockClear();
  mockTranscript.mockClear();
  const container = dom.document.getElementById('root');
  if (!container) throw new Error('Missing preview test root');
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  jest.useRealTimers();
});

it('uses selected organization presence and closes the old scope before switching to personal', () => {
  render();
  expect(mockConnectPresence).toHaveBeenLastCalledWith(expect.any(Function), 'org-owned');
  mockOrganizationID = null;
  render();
  expect(mockConnections[0]?.close).toHaveBeenCalledTimes(1);
  expect(mockConnectPresence).toHaveBeenLastCalledWith(expect.any(Function), undefined);
});

it('renders loading then the complete paginated model catalog', async () => {
  const pending = Promise.withResolvers<unknown>();
  const model = {
    id: 'first',
    providerID: 'provider',
    name: 'First model',
    limit: { context: 100, output: 10 },
    variants: [],
  };
  mockCommand.mockImplementation(
    async (_instance: string, type: string, body: { cursor?: number }) => {
      if (type === 'list_directories') return reply({ directory: '/fixture', directories: [] });
      if (type === 'list_agents') return reply({ agents: [] });
      if (!body.cursor) {
        return reply({ models: [model], nextCursor: 1, catalogRevision: 'a'.repeat(64) });
      }
      return pending.promise;
    }
  );
  render();
  await chooseHost();
  await until(() => mockCommand.mock.calls.some(call => call[2]?.cursor === 1));
  expect(dom.document.body.textContent).toContain('Loading host options');
  await act(async () =>
    pending.resolve(
      reply({
        models: [{ ...model, id: 'last', name: 'Last model' }],
        nextCursor: null,
        catalogRevision: 'a'.repeat(64),
      })
    )
  );
  await until(() => dom.document.body.textContent?.includes('Last model') === true);
  expect(dom.document.body.textContent).toContain('First model');
});

it.each([false, true])('keeps empty and failed discovery distinct (failed=%s)', async failed => {
  mockCommand.mockImplementation(async (_instance: string, type: string) => {
    if (type === 'list_directories') return reply({ directory: '/fixture', directories: [] });
    if (type === 'list_agents') return reply({ agents: [] });
    return failed
      ? { commandID: 'command', instanceID: 'host', status: 'unknown' }
      : reply({ models: [], nextCursor: null, catalogRevision: 'a'.repeat(64) });
  });
  render();
  await chooseHost();
  await until(
    () =>
      dom.document.body.textContent?.includes(
        failed ? 'Discovery outcome unknown' : 'No models advertised'
      ) === true
  );
  expect(dom.document.body.textContent?.includes('No models advertised')).toBe(!failed);
});

it.each(['response', 'outcome'])(
  'requires explicit refresh after a catalog revision changes in the %s',
  async kind => {
    const model = {
      id: 'first',
      providerID: 'provider',
      name: 'First model',
      limit: { context: 100, output: 10 },
      variants: [],
    };
    mockCommand.mockImplementation(
      async (
        _instance: string,
        type: string,
        body: { cursor?: number; catalogRevision?: string }
      ) => {
        if (type === 'list_directories') return reply({ directory: '/fixture', directories: [] });
        if (type === 'list_agents') return reply({ agents: [] });
        if (!body.cursor) {
          return reply({ models: [model], nextCursor: 1, catalogRevision: 'a'.repeat(64) });
        }
        expect(body.catalogRevision).toBe('a'.repeat(64));
        return kind === 'response'
          ? reply({ models: [model], nextCursor: null, catalogRevision: 'b'.repeat(64) })
          : {
              commandID: 'command',
              instanceID: 'host',
              status: 'replied',
              body: {
                status: 'failed',
                error: { code: 'catalog_changed', message: 'Catalog changed on the host' },
              },
            };
      }
    );
    render();
    await chooseHost();
    await until(
      () => dom.document.body.textContent?.includes('Refresh host options to try again.') === true
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(mockCommand.mock.calls.filter(call => call[1] === 'list_models')).toHaveLength(2);
    expect(dom.document.body.textContent).not.toContain('First model');
  }
);

it('feeds canonical live native messages into the existing Cloud transcript and distinguishes empty, incomplete, reset and denied states', async () => {
  mockListSessions.mockResolvedValue({
    items: [
      { sessionID: 'ses_shared', live: true, tenant: { type: 'user', id: 'owned' }, createdAt: 1 },
    ],
    cursor: null,
  });
  render();
  await until(() => dom.document.body.textContent?.includes('ses_shared') === true);
  const button = Array.from(dom.document.querySelectorAll('button')).find(node =>
    node.textContent?.includes('ses_shared')
  );
  if (!button) throw new Error('Missing native session');
  act(() => button.click());
  const listener = mockSessionListeners[0];
  if (!listener) throw new Error('Native session did not attach');
  const base: NativeSessionState = {
    connection: 'connected',
    runnerConnected: true,
    session: {
      id: 'ses_shared',
      origin: { directory: '/owned' },
      time: { created: 1, updated: 1 },
    },
    snapshot: { position: 1, revision: 1 },
    messages: [],
    pending: { permissions: [], questions: [] },
    events: [],
    commands: {},
  };
  act(() => listener(base));
  expect(dom.document.body.textContent).toContain('This session has no messages yet.');
  const populated: NativeSessionState = {
    ...base,
    messages: [
      {
        seq: 1,
        message: {
          id: 'msg_user',
          type: 'user',
          time: { created: 1 },
          text: 'Question',
          files: [{ mime: 'image/png', data: 'aW1hZ2U=', source: { type: 'inline' } }],
        },
      },
      {
        seq: 2,
        message: {
          id: 'msg_answer',
          type: 'assistant',
          time: { created: 2, completed: 3 },
          cost: 2,
          error: { type: 'provider', message: 'Provider error' },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'shell',
              state: { status: 'running', input: { command: 'pwd' } },
            },
            { type: 'text', text: 'Answer' },
          ],
        },
      },
    ],
  };
  act(() => listener(populated));
  const projected = mockTranscript.mock.lastCall?.[0].messages;
  expect(projected?.map(message => message.info.id)).toEqual(['msg_user', 'msg_answer']);
  expect(projected?.[0]?.parts[1]).toMatchObject({
    type: 'file',
    url: 'data:image/png;base64,aW1hZ2U=',
  });
  expect(projected?.[1]).toMatchObject({
    info: { cost: 2, error: { data: { message: 'Provider error' } } },
    parts: [
      { type: 'tool', tool: 'bash', state: { status: 'running' } },
      { type: 'text', text: 'Answer' },
    ],
  });
  act(() =>
    listener({
      ...populated,
      connection: 'disconnected',
      runnerConnected: false,
      error: 'Native transcript may be incomplete because live replay is unavailable.',
    })
  );
  expect(mockTranscript.mock.lastCall?.[0].messages).toEqual(projected);
  expect(dom.document.body.textContent).toContain('live replay is unavailable');
  act(() =>
    listener({
      ...populated,
      messages: populated.messages.map(item => ({ ...item, incomplete: true })),
    })
  );
  expect(dom.document.body.textContent).toContain('Native transcript recovery is incomplete');
  expect(dom.document.body.textContent).not.toContain('This session has no messages yet.');
  for (const error of ['forbidden', 'session_deleted']) {
    act(() => listener({ ...base, session: undefined, connection: 'disconnected', error }));
    expect(dom.document.body.textContent).toContain(error);
    expect(dom.document.body.textContent).not.toContain('This session has no messages yet.');
  }
});
